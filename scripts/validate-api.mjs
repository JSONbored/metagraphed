import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import { API_ROUTES, compileRoutePattern } from "../src/contracts.mjs";
import { handleRequest } from "../workers/api.mjs";
import {
  artifactFilePath,
  createLocalArtifactEnv,
  readJson,
  repoRoot,
} from "./lib.mjs";

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

const env = createLocalArtifactEnv();
const healthLatest = await readJson(artifactFilePath("health/latest.json"));
const latestHealthHistoryDate = (
  healthLatest.probe_finished_at || healthLatest.generated_at
).slice(0, 10);

const checks = [
  ["/api/v1", (body) => assert.equal(Array.isArray(body.data.routes), true)],
  [
    "/api/v1/subnets",
    (body) => assert.equal(Array.isArray(body.data.subnets), true),
  ],
  ["/api/v1/subnets/7", (body) => assert.equal(body.data.subnet.netuid, 7)],
  [
    "/api/v1/profiles?profile_level=adapter-backed",
    (body) =>
      assert.equal(
        body.data.profiles.every(
          (profile) => profile.profile_level === "adapter-backed",
        ),
        true,
      ),
  ],
  [
    "/api/v1/subnets/7/profile",
    (body) => assert.equal(body.data.profile.netuid, 7),
  ],
  [
    "/api/v1/subnets/7/surfaces?kind=subnet-api&limit=3",
    (body) =>
      assert.equal(
        body.data.surfaces.every(
          (surface) => surface.netuid === 7 && surface.kind === "subnet-api",
        ),
        true,
      ),
  ],
  [
    "/api/v1/endpoints?layer=bittensor-base&limit=2",
    (body) =>
      assert.equal(
        body.data.endpoints.every(
          (endpoint) => endpoint.layer === "bittensor-base",
        ),
        true,
      ),
  ],
  [
    "/api/v1/subnets/7/endpoints?kind=subnet-api",
    (body) =>
      assert.equal(
        body.data.endpoints.every(
          (endpoint) => endpoint.netuid === 7 && endpoint.kind === "subnet-api",
        ),
        true,
      ),
  ],
  [
    "/api/v1/subnets/7/candidates?limit=2",
    (body) =>
      assert.equal(
        body.data.candidates.every((candidate) => candidate.netuid === 7),
        true,
      ),
  ],
  [
    "/api/v1/subnets/7/health?status=ok",
    (body) =>
      assert.equal(
        body.data.surfaces.every(
          (surface) => surface.netuid === 7 && surface.status === "ok",
        ),
        true,
      ),
  ],
  [
    "/api/v1/surfaces?kind=openapi",
    (body) =>
      assert.equal(
        body.data.surfaces.every((surface) => surface.kind === "openapi"),
        true,
      ),
  ],
  [
    "/api/v1/candidates?state=schema-valid",
    (body) =>
      assert.equal(
        body.data.candidates.every(
          (candidate) => candidate.state === "schema-valid",
        ),
        true,
      ),
  ],
  [
    "/api/v1/providers",
    (body) => assert.equal(Array.isArray(body.data.providers), true),
  ],
  [
    "/api/v1/providers/allways",
    (body) => assert.equal(body.data.provider.id, "allways"),
  ],
  [
    "/api/v1/providers/allways/endpoints",
    (body) =>
      assert.equal(
        body.data.endpoints.every(
          (endpoint) => endpoint.provider === "allways",
        ),
        true,
      ),
  ],
  [
    "/api/v1/coverage",
    (body) =>
      assert.equal(Number.isInteger(body.data.chain_subnet_count), true),
  ],
  [
    "/api/v1/curation?coverage_level=probed",
    (body) =>
      assert.equal(
        body.data.curation.every((entry) => entry.coverage_level === "probed"),
        true,
      ),
  ],
  ["/api/v1/gaps", (body) => assert.equal(Array.isArray(body.data.gaps), true)],
  [
    "/api/v1/review/gaps?limit=3",
    (body) => assert.equal(body.data.priorities.length <= 3, true),
  ],
  [
    "/api/v1/review/profile-completeness?limit=3",
    (body) => assert.equal(body.data.profiles.length <= 3, true),
  ],
  [
    "/api/v1/review/adapter-candidates?limit=3",
    (body) => assert.equal(body.data.candidates.length <= 3, true),
  ],
  [
    "/api/v1/review/enrichment-queue?lane=direct-submission&limit=3",
    (body) => {
      assert.equal(body.data.queue.length <= 3, true);
      assert.equal(
        body.data.queue.every((entry) => entry.lane === "direct-submission"),
        true,
      );
    },
  ],
  [
    "/api/v1/health",
    (body) => assert.equal(Array.isArray(body.data.subnets), true),
  ],
  [
    `/api/v1/health/history/${latestHealthHistoryDate}?limit=2`,
    (body) => {
      assert.equal(Array.isArray(body.data.surfaces), true);
      assert.equal(body.data.date, latestHealthHistoryDate);
      assert.equal(body.data.surfaces.length <= 2, true);
    },
  ],
  [
    "/api/v1/freshness",
    (body) =>
      assert.equal(
        Boolean(body.data.summary.native_snapshot_captured_at),
        true,
      ),
  ],
  [
    "/api/v1/source-health",
    (body) => assert.equal(Array.isArray(body.data.providers), true),
  ],
  [
    "/api/v1/evidence?q=allways",
    (body) => assert.equal(Array.isArray(body.data.claims), true),
  ],
  [
    "/api/v1/changelog",
    (body) => assert.equal(body.data.source, "generated-artifact-diff"),
  ],
  [
    "/api/v1/source-snapshots",
    (body) => assert.equal(Array.isArray(body.data.sources), true),
  ],
  [
    "/api/v1/rpc/endpoints",
    (body) => assert.equal(Array.isArray(body.data.endpoints), true),
  ],
  [
    "/api/v1/rpc/pools",
    (body) => assert.equal(Array.isArray(body.data.pools), true),
  ],
  [
    "/api/v1/endpoint-pools",
    (body) => assert.equal(Array.isArray(body.data.pools), true),
  ],
  [
    "/api/v1/endpoint-incidents?severity=critical",
    (body) =>
      assert.equal(
        body.data.incidents.every(
          (incident) => incident.severity === "critical",
        ),
        true,
      ),
  ],
  [
    "/api/v1/schemas",
    (body) => assert.equal(Array.isArray(body.data.schemas), true),
  ],
  [
    "/api/v1/adapters/allways",
    (body) => assert.equal(body.data.slug, "allways"),
  ],
  [
    "/api/v1/search?q=allways",
    (body) => assert.equal(body.data.documents.length > 0, true),
  ],
  [
    "/api/v1/contracts",
    (body) => assert.equal(body.data.primary_domain, "metagraph.sh"),
  ],
  ["/api/v1/openapi.json", (body) => assert.equal(body.data.openapi, "3.1.0")],
  [
    "/api/v1/build",
    (body) => assert.equal(Number.isInteger(body.data.artifact_count), true),
  ],
];

assert.equal(
  checks.length,
  API_ROUTES.length,
  "API validation checks must cover every configured API route",
);

for (const [route, assertion] of checks) {
  const response = await handleRequest(
    new Request(`https://metagraph.sh${route}`),
    env,
    {},
  );
  assert.equal(response.status, 200, `${route}: expected 200`);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "*",
    `${route}: missing CORS`,
  );
  assert.ok(response.headers.get("etag"), `${route}: missing ETag`);
  assert.equal(
    response.headers.get("x-metagraph-contract-version"),
    "2026-06-06.1",
    `${route}: missing contract header`,
  );
  const body = await response.json();
  assert.equal(body.ok, true, `${route}: expected ok envelope`);
  assert.equal(body.schema_version, 1, `${route}: expected schema_version 1`);
  validateWorkerResponse(route, body);
  assertion(body);
}

const paginated = await handleRequest(
  new Request(
    "https://metagraph.sh/api/v1/subnets?limit=2&sort=netuid&order=desc",
  ),
  env,
  {},
);
const paginatedBody = await paginated.json();
assert.equal(paginated.status, 200, "paginated subnets should return 200");
assert.equal(paginatedBody.data.subnets.length, 2);
assert.equal(paginatedBody.meta.pagination.returned, 2);
assert.equal(paginatedBody.meta.pagination.next_cursor, 2);
assert.equal(
  paginatedBody.data.subnets[0].netuid > paginatedBody.data.subnets[1].netuid,
  true,
);

for (const route of [
  "/api/v1/subnets?limit=0",
  "/api/v1/subnets?cursor=-1",
  "/api/v1/subnets?order=sideways",
  "/api/v1/subnets?sort=unknown_field",
  "/api/v1/subnets?netuid=not-a-number",
]) {
  const response = await handleRequest(
    new Request(`https://metagraph.sh${route}`),
    env,
    {},
  );
  assert.equal(response.status, 400, `${route}: expected invalid query`);
  assert.equal(
    response.headers.get("x-metagraph-error-code"),
    "invalid_query",
    `${route}: expected invalid_query code`,
  );
}

const etagSource = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets/7"),
  env,
  {},
);
const cached = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets/7", {
    headers: {
      "if-none-match": etagSource.headers.get("etag"),
    },
  }),
  env,
  {},
);
assert.equal(cached.status, 304, "matching ETag should return 304");

const missing = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets/9999"),
  env,
  {},
);
assert.equal(missing.status, 404, "missing subnet should return 404");
assert.equal(
  validateErrorEnvelope(await missing.json()).ok,
  false,
  "missing subnet should return error envelope",
);

const proxy = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", { method: "POST" }),
  env,
  {},
);
assert.equal(proxy.status, 501, "RPC proxy should be disabled by default");

const blockedRpc = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "author_submitExtrinsic",
      params: [],
    }),
  }),
  {
    ...env,
    METAGRAPH_ENABLE_RPC_PROXY: "true",
  },
  {},
);
assert.equal(
  blockedRpc.status,
  403,
  "unsafe RPC methods must be blocked when proxy flag is enabled",
);

const r2Fallback = await handleRequest(
  new Request("https://metagraph.sh/api/v1/changelog"),
  {
    ASSETS: {
      async fetch() {
        return new Response("not found", { status: 404 });
      },
    },
    METAGRAPH_CONTROL: {
      async get(key) {
        assert.equal(key, "metagraph:latest");
        return { latest_prefix: "latest/" };
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        assert.equal(key, "latest/changelog.json");
        return {
          async json() {
            return {
              schema_version: 1,
              contract_version: "2026-06-06.1",
              generated_at: "1970-01-01T00:00:00.000Z",
              source: "generated-artifact-diff",
            };
          },
        };
      },
    },
  },
  {},
);
assert.equal(
  r2Fallback.status,
  200,
  "Worker should fall back to R2 with KV latest pointer",
);

console.log(`Validated ${checks.length} Worker API route(s).`);

function validateWorkerResponse(route, body) {
  const url = new URL(`https://metagraph.sh${route}`);
  const routeContract = API_ROUTES.find((entry) =>
    compileRoutePattern(entry.path).test(url.pathname),
  );
  assert.ok(routeContract, `${route}: missing route contract`);

  const operation =
    openapi.paths?.[routeContract.path]?.[routeContract.method.toLowerCase()];
  const responseSchema =
    operation?.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(responseSchema, `${route}: missing OpenAPI 200 schema`);

  const validator = ajv.compile({
    components: openapi.components,
    ...responseSchema,
  });
  assert.equal(
    validator(body),
    true,
    `${route}: Worker response must match generated OpenAPI schema: ${ajv.errorsText(
      validator.errors,
    )}`,
  );
}

function validateErrorEnvelope(body) {
  const validator = ajv.compile({
    components: openapi.components,
    $ref: "#/components/schemas/ErrorEnvelope",
  });
  assert.equal(
    validator(body),
    true,
    `error envelope must match generated OpenAPI schema: ${ajv.errorsText(
      validator.errors,
    )}`,
  );
  return body;
}
