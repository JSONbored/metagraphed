import assert from "node:assert/strict";
import path from "node:path";
import {
  API_ROUTES,
  FEED_ROUTES,
  CONTRACT_VERSION,
  PRIMARY_DOMAIN,
} from "../src/contracts.ts";
import { readJson, repoRoot } from "./lib.ts";

// The OpenAPI document + api-index are generated JSON, deep-traversed only to
// check shape/coverage invariants -- never trusted for control flow. Mirrors
// the readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const openapi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const apiIndex = await readJson(
  path.join(repoRoot, "public/metagraph/api-index.json"),
);
const errors: string[] = [];

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

const documentedRoutes = new Set<string>();
for (const [pathValue, methods] of Object.entries(
  (openapi.paths as Row | undefined) || {},
)) {
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
  (openapi.components?.schemas as Row | undefined) || {},
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

// #8703: feeds are their own registry (they serve feed documents, not the
// artifact envelope -- see FEED_ROUTES' own comment in src/contracts.ts), so
// the document holds API_ROUTES plus each feed family's bare path and its three
// format suffixes. Counted rather than skipped: an exact total is what catches
// a path appearing in OpenAPI that no registry claims.
const FEED_OPENAPI_ROUTES = FEED_ROUTES.flatMap((entry) => [
  entry.path,
  ...entry.formats.map((format) => `${entry.path}.${format}`),
]);
for (const feedPath of FEED_OPENAPI_ROUTES) {
  check(
    documentedRoutes.has(`GET ${feedPath}`),
    `OpenAPI is missing feed route GET ${feedPath}`,
  );
}

const expectedRoutes = API_ROUTES.length + FEED_OPENAPI_ROUTES.length;
assert.equal(documentedRoutes.size, expectedRoutes);
console.log(
  `OpenAPI validation passed for ${API_ROUTES.length} route(s) + ${FEED_OPENAPI_ROUTES.length} feed route(s).`,
);

function check(condition: unknown, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}
