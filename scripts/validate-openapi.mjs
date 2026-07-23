import assert from "node:assert/strict";
import path from "node:path";
import {
  API_ROUTES,
  CONTRACT_VERSION,
  PRIMARY_DOMAIN,
} from "../src/contracts.mjs";
import { readJson, repoRoot } from "./lib.ts";

const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const apiIndex = await readJson(
  path.join(repoRoot, "public/metagraph/api-index.json"),
);
const errors = [];

check(openapi.openapi === "3.1.0", "OpenAPI document must use version 3.1.0");
check(
  openapi.info?.version === CONTRACT_VERSION,
  "OpenAPI info.version must match the backend contract version",
);
check(
  openapi.servers?.[0]?.url === `https://${PRIMARY_DOMAIN}`,
  "OpenAPI server must point at metagraph.sh",
);
check(
  Boolean(openapi.components?.schemas?.SuccessEnvelope),
  "OpenAPI must define SuccessEnvelope",
);
check(
  Boolean(openapi.components?.schemas?.ErrorEnvelope),
  "OpenAPI must define ErrorEnvelope",
);
check(
  Boolean(openapi.components?.schemas?.ResponseMeta),
  "OpenAPI must define ResponseMeta",
);
check(
  Array.isArray(openapi.components?.schemas?.Surface?.properties?.kind?.enum) ||
    Boolean(openapi.components?.schemas?.Surface?.properties?.kind?.$ref),
  "OpenAPI Surface schema must constrain kind",
);
check(
  Boolean(openapi.components?.schemas?.CandidateSurface),
  "OpenAPI must define CandidateSurface",
);

const documentedRoutes = new Set();
for (const [pathValue, methods] of Object.entries(openapi.paths || {})) {
  for (const method of Object.keys(methods || {})) {
    documentedRoutes.add(`${method.toUpperCase()} ${pathValue}`);
  }
}

for (const route of API_ROUTES) {
  check(
    documentedRoutes.has(`${route.method} ${route.path}`),
    `OpenAPI is missing route ${route.method} ${route.path}`,
  );
}

for (const route of apiIndex.routes || []) {
  check(
    documentedRoutes.has(`${route.method} ${route.path}`),
    `api-index route is missing from OpenAPI: ${route.method} ${route.path}`,
  );
}

for (const route of API_ROUTES) {
  const operation = openapi.paths?.[route.path]?.[route.method.toLowerCase()];
  check(
    Boolean(operation?.operationId),
    `OpenAPI route ${route.path} is missing operationId`,
  );
  check(
    Array.isArray(operation?.tags) && operation.tags.length > 0,
    `OpenAPI route ${route.path} is missing tags`,
  );
  check(
    Boolean(
      operation?.responses?.["200"]?.content?.["application/json"]?.schema,
    ),
    `OpenAPI route ${route.path} is missing 200 JSON schema`,
  );
  const dataRef =
    operation?.responses?.["200"]?.content?.["application/json"]?.schema
      ?.allOf?.[1]?.properties?.data?.$ref;
  if (dataRef) {
    const schemaName = dataRef.replace("#/components/schemas/", "");
    check(
      Boolean(openapi.components?.schemas?.[schemaName]),
      `OpenAPI route ${route.path} references missing schema ${schemaName}`,
    );
    check(
      !["GenericArtifact", "JsonObject"].includes(schemaName),
      `OpenAPI route ${route.path} must not expose generic data schema ${schemaName}`,
    );
  }
}

for (const [artifactName, schema] of Object.entries(
  openapi.components?.schemas || {},
)) {
  if (artifactName.endsWith("Artifact")) {
    check(
      JSON.stringify(schema) !==
        JSON.stringify({ $ref: "#/components/schemas/GenericArtifact" }),
      `OpenAPI artifact component ${artifactName} must not be a GenericArtifact alias`,
    );
  }
}

for (const forbidden of ["subnet.health", "localhost", "127.0.0.1"]) {
  check(
    !JSON.stringify(openapi).includes(forbidden),
    `OpenAPI must not reference ${forbidden}`,
  );
}

if (errors.length > 0) {
  console.error(`OpenAPI validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

assert.equal(documentedRoutes.size, API_ROUTES.length);
console.log(`OpenAPI validation passed for ${API_ROUTES.length} route(s).`);

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}
