import type { Ajv2020, ValidateFunction } from "ajv/dist/2020.js";

// Memoized OpenAPI component-schema validators for validate-schemas.ts.
// Each distinct schema_ref compiles at most once per process (#2093).
export function createComponentValidatorCompiler(
  ajv: Ajv2020,
  componentsSchemaId = "https://metagraph.sh/openapi-components.schema.json",
) {
  const cache = new Map<string, ValidateFunction>();
  return function compileComponentValidator(
    schemaRef: string,
  ): ValidateFunction {
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
