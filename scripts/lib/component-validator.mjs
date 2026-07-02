// Memoized OpenAPI component-schema validators for validate-schemas.mjs.
// Each distinct schema_ref compiles at most once per process (#2093).
export function createComponentValidatorCompiler(
  ajv,
  componentsSchemaId = "https://metagraph.sh/openapi-components.schema.json",
) {
  const cache = new Map();
  return function compileComponentValidator(schemaRef) {
    const cached = cache.get(schemaRef);
    if (cached) return cached;
    const schemaName = schemaRef.replace("#/components/schemas/", "");
    const validator = ajv.compile({
      $ref: `${componentsSchemaId}#/components/schemas/${schemaName}`,
    });
    cache.set(schemaRef, validator);
    return validator;
  };
}
