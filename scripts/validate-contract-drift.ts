import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildApiComponentBundle } from "./bundle-schemas.ts";
import { generateClientSource } from "./generate-client.ts";
import { generateOpenApiZodComponents } from "./generate-openapi-zod-components.ts";
import { buildCanonicalOpenApiArtifact } from "./openapi-components.ts";
import {
  removeInlinedOpenApiSpec,
  writeInlinedOpenApiSpec,
} from "./openapi-inline-examples.ts";
import {
  readJson,
  repoRoot,
  stableStringify,
  stripJsonComments,
} from "./lib.ts";
import { promises as fs } from "node:fs";
import {
  CONTRACT_VERSION,
  FEED_CONTENT_TYPES_BY_FORMAT,
  FEED_ROUTES,
} from "../src/contracts.ts";

// The OpenAPI document read below is generated JSON, deep-traversed only to
// compare against a freshly-rebuilt copy or report a route path -- never
// trusted for control flow. Mirrors the readJson/readArtifactJson precedent
// in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const errors: string[] = [];

// #stale-contract-version-env: wrangler.jsonc's vars.METAGRAPH_CONTRACT_VERSION
// is a hardcoded literal, separate from src/contracts.ts's CONTRACT_VERSION
// constant it's meant to seed the deployed Worker's default with (see
// workers/responses.ts's contractVersion(): env.METAGRAPH_CONTRACT_VERSION ||
// CONTRACT_VERSION -- the env var exists so a specific deploy CAN override it,
// e.g. for testing, but the checked-in default must track the real constant).
// PR #2828 bumped CONTRACT_VERSION without updating this literal, and nothing
// caught the drift -- resolveLiveEconomics (src/health-serving.ts) then
// silently rejected every live-KV economics blob as a "different contract"
// mismatch and permanently fell back to the stale committed R2 artifact, with
// no error anywhere (discovered 2026-07-26, confirmed months after #2828).
const wranglerConfig: Row = JSON.parse(
  stripJsonComments(
    await fs.readFile(path.join(repoRoot, "wrangler.jsonc"), "utf8"),
  ),
);
check(
  wranglerConfig.vars?.METAGRAPH_CONTRACT_VERSION === CONTRACT_VERSION,
  `wrangler.jsonc's vars.METAGRAPH_CONTRACT_VERSION ("${wranglerConfig.vars?.METAGRAPH_CONTRACT_VERSION}") ` +
    `must match src/contracts.ts's CONTRACT_VERSION ("${CONTRACT_VERSION}") -- ` +
    "run `npm run types:workers` after fixing it (workers/worker-configuration.d.ts embeds the same literal).",
);

const currentBundle = await readJson(
  path.join(repoRoot, "schemas/api-components.schema.json"),
);
const expectedBundle = await buildApiComponentBundle();
check(
  stableStringify(currentBundle) === stableStringify(expectedBundle),
  "schemas/api-components.schema.json is stale. Run npm run schemas:bundle.",
);

// scripts/openapi-components.ts overlays the Zod-owned components over the
// hand-edited bundle -- a name defined on both sides means the hand-edited
// copy is silently discarded rather than published, so the two key sets must
// be disjoint (#8827).
const handEditedComponentNames = Object.keys(
  (expectedBundle.components as Row).schemas as Row,
);
const zodComponentNames = new Set(Object.keys(generateOpenApiZodComponents()));
const shadowedComponentNames = handEditedComponentNames.filter((name) =>
  zodComponentNames.has(name),
);
check(
  shadowedComponentNames.length === 0,
  `Component name(s) defined in BOTH the hand-edited bundle and schemas-src, so the hand-edited copy is silently discarded by scripts/openapi-components.ts: ${shadowedComponentNames.join(", ")}. Delete the hand-edited key.`,
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

// Regenerate through the SAME inlined projection generate-types.ts writes from
// (#8763) — openapi-typescript cannot read the hoisted components.examples map,
// so reading the published document directly here would rebuild types with every
// `@example` JSDoc block missing and report the committed, correct copies as
// stale. One shared module, so "current" means the same thing in both places.
const { specPath: inlinedSpecPath } = await writeInlinedOpenApiSpec();
const typegen = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules/openapi-typescript/bin/cli.js"),
    inlinedSpecPath,
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    // The generated .d.ts is ~1 MiB and grows with every route; the default 1 MiB
    // stdout cap would SIGTERM the child (ENOBUFS) and misreport it as a drift
    // failure. Match the 32 MiB buffer the build's generate-types.ts uses.
    maxBuffer: 32 * 1024 * 1024,
  },
);
await removeInlinedOpenApiSpec(inlinedSpecPath);
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

// #8703: feed routes answer a different response contract -- an RSS/Atom/JSON
// Feed document, never the success envelope -- so the envelope assertion below
// cannot apply to them. They are NOT simply exempted: the loop after this one
// holds them to their own contract instead, so a feed route that silently
// started returning an envelope (or lost its media types) still fails here.
//
// Derived from FEED_ROUTES rather than pattern-matched on "/feeds/", so a route
// that merely looks feed-shaped cannot opt itself out of envelope validation.
const FEED_OPENAPI_PATHS = new Set(
  FEED_ROUTES.flatMap((entry) => [
    entry.path,
    ...entry.formats.map((format) => `${entry.path}.${format}`),
  ]),
);
const FEED_MEDIA_TYPES = new Set<string>(
  Object.values(FEED_CONTENT_TYPES_BY_FORMAT),
);

// The OpenAPI 3.1 path-item verbs. A path item also carries non-operation keys
// (`parameters`, `summary`, `$ref`), so the operation cannot simply be "the
// first value".
const OPENAPI_OPERATION_VERBS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

for (const [routePath, methods] of Object.entries(
  (currentOpenApi.paths as Row | undefined) || {},
)) {
  if (FEED_OPENAPI_PATHS.has(routePath)) continue;
  // Whichever verb this path publishes, DERIVED from the path item rather than
  // named. Reading `.get` here meant a POST path looked like a route with no
  // typed response at all -- the same "every route is a GET" assumption that
  // kept POST /api/v1/ask out of the contract (#9092). Enumerating `get ?? post`
  // would just move the assumption one verb along.
  const operation = Object.entries(methods as Row).find(([verb]) =>
    OPENAPI_OPERATION_VERBS.has(verb),
  )?.[1] as Row | undefined;
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

// #8703: the feed routes' own contract. Every path FEED_ROUTES declares must
// exist in OpenAPI, serve at least one real feed media type, and never claim
// application/json for its 200 -- a generated client that believed that would
// parse an RSS document as JSON.
for (const routePath of FEED_OPENAPI_PATHS) {
  const operation = ((currentOpenApi.paths as Row | undefined) || {})[routePath]
    ?.get;
  check(
    Boolean(operation),
    `Feed route ${routePath} is declared in FEED_ROUTES but missing from OpenAPI. Run npm run build.`,
  );
  if (!operation) continue;
  const content = operation.responses?.["200"]?.content || {};
  const mediaTypes = Object.keys(content);
  check(
    mediaTypes.some((mediaType) => FEED_MEDIA_TYPES.has(mediaType)),
    `Feed route ${routePath} declares no feed media type (got: ${mediaTypes.join(", ") || "none"}).`,
  );
  check(
    !mediaTypes.includes("application/json"),
    `Feed route ${routePath} claims application/json; feeds serve application/feed+json, not the API envelope.`,
  );
}

if (errors.length > 0) {
  failWithErrors();
}

console.log("Contract drift validation passed.");

function failWithErrors(): never {
  console.error(
    `Contract drift validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function check(condition: unknown, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}
