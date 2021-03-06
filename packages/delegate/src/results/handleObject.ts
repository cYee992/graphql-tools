import {
  GraphQLCompositeType,
  GraphQLError,
  GraphQLSchema,
  isAbstractType,
  FieldNode,
  GraphQLObjectType,
  GraphQLResolveInfo,
} from 'graphql';

import { collectFields, GraphQLExecutionContext, setErrors, slicedError } from '@graphql-tools/utils';
import { setObjectSubschema, isSubschemaConfig } from '../Subschema';
import { mergeFields } from '../mergeFields';
import { MergedTypeInfo, SubschemaConfig, StitchingInfo } from '../types';

export function handleObject(
  type: GraphQLCompositeType,
  object: any,
  errors: ReadonlyArray<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig,
  context: Record<string, any>,
  info: GraphQLResolveInfo,
  skipTypeMerging?: boolean
) {
  const stitchingInfo = info?.schema.extensions?.stitchingInfo;

  setErrors(
    object,
    errors.map(error => slicedError(error))
  );

  setObjectSubschema(object, subschema);

  if (skipTypeMerging || !stitchingInfo) {
    return object;
  }

  const typeName = isAbstractType(type) ? info.schema.getTypeMap()[object.__typename].name : type.name;
  const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
  let targetSubschemas: Array<SubschemaConfig>;

  if (mergedTypeInfo != null) {
    targetSubschemas = mergedTypeInfo.subschemas;
  }

  if (!targetSubschemas) {
    return object;
  }

  targetSubschemas = targetSubschemas.filter(s => s !== subschema);
  if (!targetSubschemas.length) {
    return object;
  }

  const fieldNodes = getFieldsNotInSubschema(info, subschema, mergedTypeInfo, object.__typename);

  return mergeFields(
    mergedTypeInfo,
    typeName,
    object,
    fieldNodes,
    [subschema as SubschemaConfig],
    targetSubschemas,
    context,
    info
  );
}

function collectSubFields(info: GraphQLResolveInfo, typeName: string): Record<string, Array<FieldNode>> {
  let subFieldNodes: Record<string, Array<FieldNode>> = Object.create(null);
  const visitedFragmentNames = Object.create(null);

  const type = info.schema.getType(typeName) as GraphQLObjectType;
  const partialExecutionContext = ({
    schema: info.schema,
    variableValues: info.variableValues,
    fragments: info.fragments,
  } as unknown) as GraphQLExecutionContext;

  info.fieldNodes.forEach(fieldNode => {
    subFieldNodes = collectFields(
      partialExecutionContext,
      type,
      fieldNode.selectionSet,
      subFieldNodes,
      visitedFragmentNames
    );
  });

  const stitchingInfo = info.schema.extensions.stitchingInfo as StitchingInfo;
  const selectionSetsByType = stitchingInfo.selectionSetsByType;
  const selectionSetsByField = stitchingInfo.selectionSetsByField;

  Object.keys(subFieldNodes).forEach(responseName => {
    const fieldName = subFieldNodes[responseName][0].name.value;
    const typeSelectionSet = selectionSetsByType[typeName];
    if (typeSelectionSet != null) {
      subFieldNodes = collectFields(
        partialExecutionContext,
        type,
        typeSelectionSet,
        subFieldNodes,
        visitedFragmentNames
      );
    }
    const fieldSelectionSet = selectionSetsByField?.[typeName]?.[fieldName];
    if (fieldSelectionSet != null) {
      subFieldNodes = collectFields(
        partialExecutionContext,
        type,
        fieldSelectionSet,
        subFieldNodes,
        visitedFragmentNames
      );
    }
  });

  return subFieldNodes;
}

function getFieldsNotInSubschema(
  info: GraphQLResolveInfo,
  subschema: GraphQLSchema | SubschemaConfig,
  mergedTypeInfo: MergedTypeInfo,
  typeName: string
): Array<FieldNode> {
  const typeMap = isSubschemaConfig(subschema) ? mergedTypeInfo.typeMaps.get(subschema) : subschema.getTypeMap();
  const fields = (typeMap[typeName] as GraphQLObjectType).getFields();

  const subFieldNodes = collectSubFields(info, typeName);

  let fieldsNotInSchema: Array<FieldNode> = [];
  Object.keys(subFieldNodes).forEach(responseName => {
    const fieldName = subFieldNodes[responseName][0].name.value;
    if (!(fieldName in fields)) {
      fieldsNotInSchema = fieldsNotInSchema.concat(subFieldNodes[responseName]);
    }
  });

  return fieldsNotInSchema;
}
