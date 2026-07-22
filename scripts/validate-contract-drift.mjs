import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildApiComponentBundle } from "./bundle-schemas.ts";
import { generateClientSource } from "./generate-client.mjs";
import { buildCanonicalOpenApiArtifact } from "./openapi-components.mjs";
import { readJson, repoRoot, stableStringify } from "./lib.mjs";
import { promises as fs } from "node:fs";

const errors = [];

const currentBundle = await readJson(
  path.join(repoRoot, "schemas/api-components.schema.json"),
);
const expectedBundle = await buildApiComponentBundle();
check(
  stableStringify(currentBundle) === stableStringify(expectedBundle),
  "schemas/api-components.schema.json is stale. Run npm run schemas:bundle.",
);

const currentOpenApi = await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
);
const expectedOpenApi = await buildCanonicalOpenApiArtifact(
  currentOpenApi["x-metagraphed"]?.generated_at,
);
const openApiMatches =
  stableStringify(currentOpenApi) === stableStringify(expectedOpenApi);
check(
  openApiMatches,
  "public/metagraph/openapi.json is stale. Run npm run build.",
);

if (!openApiMatches) {
  failWithErrors();
}

const typegen = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules/openapi-typescript/bin/cli.js"),
    "public/metagraph/openapi.json",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    // The generated .d.ts is ~1 MiB and grows with every route; the default 1 MiB
    // stdout cap would SIGTERM the child (ENOBUFS) and misreport it as a drift
    // failure. Match the 32 MiB buffer the build's generate-types.mjs uses.
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (typegen.status !== 0) {
  process.stdout.write(typegen.stdout || "");
  process.stderr.write(typegen.stderr || "");
  errors.push("openapi-typescript failed.");
} else {
  for (const relativePath of [
    "packages/contract/index.d.ts",
    "public/metagraph/types.d.ts",
  ]) {
    const current = await fs.readFile(
      path.join(repoRoot, relativePath),
      "utf8",
    );
    check(current === typegen.stdout, `${relativePath} is stale.`);
  }
}

const generatedClient = await fs.readFile(
  path.join(repoRoot, "generated/metagraphed-client.ts"),
  "utf8",
);
check(
  generatedClient === generateClientSource(),
  "generated/metagraphed-client.ts is stale. Run npm run build.",
);

for (const [routePath, methods] of Object.entries(currentOpenApi.paths || {})) {
  const operation = methods.get;
  const dataRef =
    operation?.responses?.["200"]?.content?.["application/json"]?.schema
      ?.allOf?.[1]?.properties?.data?.$ref;
  check(
    Boolean(dataRef),
    `OpenAPI route ${routePath} must expose a typed data schema.`,
  );
  if (dataRef) {
    check(
      !dataRef.endsWith("/JsonObject") && !dataRef.endsWith("/GenericArtifact"),
      `OpenAPI route ${routePath} must not fall back to ${dataRef}.`,
    );
  }
}

if (errors.length > 0) {
  failWithErrors();
}

console.log("Contract drift validation passed.");

function failWithErrors() {
  console.error(
    `Contract drift validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}
