// Enforces that EVERY /api/v1 operation ships a worked response `example` in the
// OpenAPI contract, and that each example is valid against its own response
// schema. The examples are generated deterministically from the schemas at
// build time (src/openapi-sample.mjs via buildOpenApiArtifact) so they stay
// reproducible (no live data) and self-maintaining; this gate guarantees they
// stay present + schema-correct, and surfaces any schema construct the sampler
// mishandles.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import { API_ROUTES } from "../src/contracts.mjs";
import { readJson, repoRoot } from "./lib.mjs";

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

const errors = [];
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
  const validator = ajv.compile({
    components: openapi.components,
    ...responseSchema,
  });
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
