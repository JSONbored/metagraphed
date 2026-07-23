// Enforces that EVERY /api/v1 operation ships a worked response `example` in the
// OpenAPI contract, and that each example is valid against its own response
// schema. The examples are generated deterministically from the schemas at
// build time (src/openapi-sample.ts via buildOpenApiArtifact) so they stay
// reproducible (no live data) and self-maintaining; this gate guarantees they
// stay present + schema-correct, and surfaces any schema construct the sampler
// mishandles.
import { Ajv2020, type Schema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import path from "node:path";
import { API_ROUTES } from "../src/contracts.ts";
import { readJson, repoRoot } from "./lib.ts";

// ajv-formats' default export resolves to the CJS module namespace rather than
// the plugin function under this project's NodeNext + esModuleInterop
// resolution (no named-export alternative exists, unlike Ajv2020 above) --
// cast to its real callable signature rather than fight the interop.
const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;

const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

// Register the OpenAPI components block ONCE under an absolute id (mirroring
// validate-schemas.ts), instead of re-inlining all ~198 schemas into every
// per-route compile. Per-route schemas then resolve their `#/components/...`
// references against this single registered schema via an absolute `$ref`.
const COMPONENTS_ID = "https://metagraph.sh/openapi-components.schema.json";
ajv.addSchema(
  { $id: COMPONENTS_ID, components: openapi.components },
  COMPONENTS_ID,
);

// Rewrite every internal `#/components/...` reference to its absolute form so it
// resolves against the registered components schema. Pure structural transform —
// validation behaviour and error text are unchanged.
function absolutizeComponentRefs(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(absolutizeComponentRefs);
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/components/")
          ? `${COMPONENTS_ID}${value}`
          : absolutizeComponentRefs(value);
    }
    return out;
  }
  return node;
}

// Memoize compiled validators by their (rewritten) schema, so routes that share
// a response schema reuse one compiled function.
const validatorCache = new Map<string, ValidateFunction>();
function compileResponseValidator(responseSchema: unknown): ValidateFunction {
  const rewritten = absolutizeComponentRefs(responseSchema);
  const key = JSON.stringify(rewritten);
  let validator = validatorCache.get(key);
  if (!validator) {
    validator = ajv.compile(rewritten as Schema);
    validatorCache.set(key, validator);
  }
  return validator;
}

const errors: string[] = [];
let validated = 0;

for (const route of API_ROUTES) {
  const operation = openapi.paths?.[route.path]?.[route.method.toLowerCase()];
  const media = operation?.responses?.["200"]?.content?.["application/json"];
  const responseSchema = media?.schema;
  if (!responseSchema) {
    errors.push(`${route.path}: missing 200 response schema`);
    continue;
  }
  const example = media?.example;
  if (example === undefined) {
    errors.push(
      `${route.path}: missing a worked response example (every operation must ship one)`,
    );
    continue;
  }
  const validator = compileResponseValidator(responseSchema);
  if (!validator(example)) {
    errors.push(
      `${route.path}: response example failed schema validation: ${ajv.errorsText(
        validator.errors,
      )}`,
    );
    continue;
  }
  validated += 1;
}

// Full-coverage invariant: every configured route ships a valid example.
if (errors.length === 0 && validated !== API_ROUTES.length) {
  errors.push(
    `example coverage is ${validated}/${API_ROUTES.length} — every route must ship a worked example`,
  );
}

if (errors.length > 0) {
  console.error(
    `OpenAPI example validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `OpenAPI example validation passed: ${validated}/${API_ROUTES.length} route(s) ship a schema-valid worked example.`,
);
