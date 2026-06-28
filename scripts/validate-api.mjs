import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import { API_ROUTES, compileRoutePattern } from "../src/contracts.mjs";
import { handleRequest } from "../workers/api.mjs";
import {
  createLocalArtifactEnv,
  latestArtifactDate,
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

// The chain-events routes proxy to the Postgres-backed data Worker (DATA_API
// service binding). It's a separate Worker not present in this harness, so mock it
// with the bare response shapes it serves (ADR 0013) — api.mjs rewraps them in the
// canonical envelope, which is what the checks below assert.
const env = createLocalArtifactEnv({
  DATA_API: {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const headers = { "content-type": "application/json" };
      if (pathname === "/api/v1/chain-events") {
        return new Response(
          JSON.stringify({ count: 0, next_before: null, events: [] }),
          { status: 200, headers },
        );
      }
      if (pathname === "/api/v1/chain-events/stats") {
        return new Response(
          JSON.stringify({ window_blocks: 1000, groups: 0, activity: [] }),
          { status: 200, headers },
        );
      }
      return new Response(
        JSON.stringify({ block_number: 100, count: 0, events: [] }),
        { status: 200, headers },
      );
    },
  },
});
// health/latest.json is no longer generated (live-only health). Daily
// health-history snapshots are R2-only locally, so validate against the newest
// staged/public snapshot instead of inferring a date from an unrelated artifact.
const latestHealthHistoryDate = await latestArtifactDate("health/history");
assert.ok(
  latestHealthHistoryDate,
  "validate:api requires a local health/history/YYYY-MM-DD.json artifact; run `npm run build` before validating the API",
);

const checks = [
  ["/api/v1", (body) => assert.equal(Array.isArray(body.data.routes), true)],
  [
    "/api/v1/subnets",
    (body) => assert.equal(Array.isArray(body.data.subnets), true),
  ],
  ["/api/v1/subnets/7", (body) => assert.equal(body.data.subnet.netuid, 7)],
  [
    "/api/v1/subnets/7/health/trends",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.windows, "object");
      assert.equal(typeof body.data.windows["7d"].samples, "number");
    },
  ],
  [
    "/api/v1/health/trends",
    (body) => {
      assert.equal(body.data.source, "live-cron-prober");
      assert.equal(typeof body.data.windows, "object");
      assert.equal(Array.isArray(body.data.windows["7d"].subnets), true);
      assert.equal(typeof body.data.windows["7d"].subnet_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/health/percentiles",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.surfaces), true);
    },
  ],
  [
    "/api/v1/subnets/7/health/incidents",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.surfaces), true);
    },
  ],
  [
    "/api/v1/subnets/7/trajectory",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/concentration",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.neuron_count, "number");
      // Cold D1 → schema-stable null blocks; with rows → metric objects.
      assert.ok(
        body.data.stake === null || typeof body.data.stake === "object",
      );
      assert.ok(
        body.data.emission === null || typeof body.data.emission === "object",
      );
    },
  ],
  [
    "/api/v1/subnets/7/concentration/history?window=7d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/turnover?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.comparable, "boolean");
      assert.equal(typeof body.data.validators_entered, "number");
    },
  ],
  [
    "/api/v1/subnets/7/history?window=7d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/neurons/0/history?window=7d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.uid, 0);
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/metagraph",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.neurons), true);
      assert.equal(typeof body.data.neuron_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/neurons/0",
    (body) => {
      assert.equal(body.data.netuid, 7);
      // Cold harness (no D1) → neuron present but null; never 404.
      assert.equal("neuron" in body.data, true);
    },
  ],
  [
    "/api/v1/subnets/7/validators",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.validators), true);
      assert.equal(typeof body.data.validator_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/events",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.events), true);
      assert.equal(typeof body.data.event_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    (body) => {
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(typeof body.data.event_count, "number");
      assert.equal(Array.isArray(body.data.registrations), true);
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/events",
    (body) => {
      assert.equal(Array.isArray(body.data.events), true);
      assert.equal(typeof body.data.event_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/history",
    (body) => {
      assert.equal(Array.isArray(body.data.days), true);
      assert.equal(typeof body.data.day_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/extrinsics",
    (body) => {
      assert.equal(Array.isArray(body.data.extrinsics), true);
      assert.equal(typeof body.data.extrinsic_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/transfers",
    (body) => {
      assert.equal(Array.isArray(body.data.transfers), true);
      assert.equal(typeof body.data.transfer_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/counterparties",
    (body) => {
      assert.equal(Array.isArray(body.data.counterparties), true);
      assert.equal(typeof body.data.counterparty_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/subnets",
    (body) => {
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/balance",
    (body) => {
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal("balance_tao" in body.data, true);
    },
  ],
  [
    "/api/v1/blocks",
    (body) => {
      assert.equal(Array.isArray(body.data.blocks), true);
      assert.equal(typeof body.data.block_count, "number");
    },
  ],
  [
    "/api/v1/blocks/1000000",
    (body) => {
      assert.equal(body.data.ref, "1000000");
      assert.equal("block" in body.data, true);
    },
  ],
  [
    "/api/v1/blocks/1000000/extrinsics",
    (body) => {
      assert.equal(body.data.ref, "1000000");
      assert.equal(Array.isArray(body.data.extrinsics), true);
      assert.equal(typeof body.data.extrinsic_count, "number");
    },
  ],
  [
    "/api/v1/blocks/1000000/events",
    (body) => {
      assert.equal(body.data.ref, "1000000");
      assert.equal(Array.isArray(body.data.events), true);
      assert.equal(typeof body.data.event_count, "number");
    },
  ],
  [
    "/api/v1/extrinsics",
    (body) => {
      assert.equal(Array.isArray(body.data.extrinsics), true);
      assert.equal(typeof body.data.extrinsic_count, "number");
    },
  ],
  [
    `/api/v1/extrinsics/0x${"a".repeat(64)}`,
    (body) => {
      assert.equal(body.data.ref, `0x${"a".repeat(64)}`);
      assert.equal("extrinsic" in body.data, true);
    },
  ],
  [
    // Postgres-backed all-events tier (ADR 0013): DATA_API is mocked above; api.mjs
    // rewraps the bare body in the canonical envelope, so the data shape is asserted.
    "/api/v1/chain-events",
    (body) => {
      assert.equal(Array.isArray(body.data.events), true);
      assert.equal(typeof body.data.count, "number");
    },
  ],
  [
    "/api/v1/chain-events/stats",
    (body) => {
      assert.equal(Array.isArray(body.data.activity), true);
      assert.equal(typeof body.data.window_blocks, "number");
      assert.equal(typeof body.data.groups, "number");
    },
  ],
  [
    "/api/v1/blocks/100/chain-events",
    (body) => {
      assert.equal(Array.isArray(body.data.events), true);
      assert.equal(typeof body.data.count, "number");
    },
  ],
  [
    "/api/v1/chain/activity",
    (body) => {
      assert.equal(Array.isArray(body.data.days), true);
      assert.equal(typeof body.data.day_count, "number");
      assert.equal(typeof body.data.window, "string");
    },
  ],
  [
    "/api/v1/chain/calls",
    (body) => {
      assert.equal(Array.isArray(body.data.calls), true);
      assert.equal(typeof body.data.total_extrinsics, "number");
      assert.equal(typeof body.data.group_by, "string");
    },
  ],
  [
    "/api/v1/chain/signers",
    (body) => {
      assert.equal(Array.isArray(body.data.signers), true);
      assert.equal(typeof body.data.signer_count, "number");
    },
  ],
  [
    "/api/v1/chain/fees",
    (body) => {
      assert.equal(Array.isArray(body.data.daily), true);
      assert.equal(Array.isArray(body.data.top_fee_payers), true);
      assert.equal(typeof body.data.day_count, "number");
    },
  ],
  [
    "/api/v1/economics/trends",
    (body) => {
      assert.equal(Array.isArray(body.data.days), true);
      assert.equal(typeof body.data.day_count, "number");
      assert.equal(typeof body.data.window, "string");
    },
  ],
  [
    "/api/v1/subnets/7/uptime",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.surfaces), true);
      assert.equal(body.data.source, "live-cron-prober");
    },
  ],
  [
    "/api/v1/registry/leaderboards",
    (body) => {
      assert.equal(typeof body.data.boards, "object");
      assert.equal(Array.isArray(body.data.boards["most-complete"]), true);
    },
  ],
  [
    "/api/v1/compare?netuids=1",
    (body) => {
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(body.data.subnets.length, 1);
      assert.equal(body.data.subnets[0].netuid, 1);
      assert.equal(Array.isArray(body.data.requested_netuids), true);
    },
  ],
  [
    "/api/v1/rpc/usage",
    (body) => {
      assert.equal(body.data.source, "rpc-proxy");
      assert.equal(typeof body.data.summary.total_requests, "number");
      assert.equal(typeof body.data.bucket_granularity, "string");
      assert.equal(Array.isArray(body.data.buckets), true);
      assert.equal(Array.isArray(body.data.endpoints), true);
      assert.equal(Array.isArray(body.data.networks), true);
    },
  ],
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
    "/api/v1/subnets/7/overview",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.counts, "object");
      assert.equal(typeof body.data.profile, "object");
    },
  ],
  [
    "/api/v1/agent-catalog",
    (body) => {
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.callable_service_count, "number");
    },
  ],
  [
    "/api/v1/agent-catalog/7",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.services), true);
    },
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
    "/api/v1/coverage-depth?tier=machine-usable&limit=3",
    (body) => {
      assert.equal(Number.isInteger(body.data.subnet_count), true);
      assert.equal(Array.isArray(body.data.rows), true);
      assert.equal(body.data.rows.length <= 3, true);
      assert.equal(
        body.data.rows.every((row) => row.tier === "machine-usable"),
        true,
      );
      assert.equal(Array.isArray(body.data.ranked_queue), true);
    },
  ],
  [
    "/api/v1/economics",
    (body) => {
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(Number.isInteger(body.data.summary.total_validators), true);
      // Rows are ordered by emission share, highest first.
      assert.equal(
        body.data.subnets.every(
          (row, i) =>
            i === 0 ||
            (row.emission_share ?? -1) <=
              (body.data.subnets[i - 1].emission_share ?? -1),
        ),
        true,
      );
    },
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
    "/api/v1/registry/summary",
    (body) => {
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(Array.isArray(body.data.top_subnets), true);
    },
  ],
  [
    "/api/v1/lineage",
    (body) => {
      assert.equal(typeof body.data.link_count, "number");
      assert.equal(Array.isArray(body.data.links), true);
    },
  ],
  [
    "/api/v1/fixtures",
    (body) => {
      assert.equal(typeof body.data.fixture_count, "number");
      assert.equal(Array.isArray(body.data.fixtures), true);
    },
  ],
  [
    "/api/v1/agent-resources",
    (body) => {
      assert.equal(Array.isArray(body.data.resources), true);
      assert.equal(Array.isArray(body.data.mcp.tools), true);
    },
  ],
  [
    "/api/v1/review/gaps?limit=3",
    (body) => assert.equal(body.data.priorities.length <= 3, true),
  ],
  [
    "/api/v1/subnets/7/gaps",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.priorities), true);
      assert.equal(Array.isArray(body.data.enrichment_queue), true);
      assert.equal(
        body.data.priorities.every((priority) => priority.netuid === 7),
        true,
      );
    },
  ],
  [
    // identity_promotion is a drainable queue — once every subnet's source-repo
    // identity is curated it is legitimately empty. Assert the filter only ever
    // returns matching profiles, not that any remain.
    "/api/v1/review/profile-completeness?identity_promotion_kinds=source-repo&sort=identity_promotion_kind_count&order=desc",
    (body) => {
      assert.equal(Array.isArray(body.data.profiles), true);
      assert.equal(
        body.data.profiles.every((profile) =>
          profile.identity_promotion_kinds.includes("source-repo"),
        ),
        true,
      );
    },
  ],
  [
    "/api/v1/review/adapter-candidates?limit=3",
    (body) => assert.equal(body.data.candidates.length <= 3, true),
  ],
  [
    "/api/v1/review/enrichment-queue?lane=direct-submission&direct_submission_kinds=openapi&limit=3",
    (body) => {
      assert.equal(body.data.queue.length <= 3, true);
      assert.equal(
        body.data.queue.every(
          (entry) =>
            entry.lane === "direct-submission" &&
            entry.direct_submission_kinds.includes("openapi"),
        ),
        true,
      );
    },
  ],
  [
    "/api/v1/review/enrichment-evidence?evidence_action=replace-stale-evidence&missing_kinds=openapi&limit=3",
    (body) => {
      assert.equal(body.data.entries.length <= 3, true);
      assert.equal(
        body.data.entries.every(
          (entry) =>
            entry.evidence_action === "replace-stale-evidence" &&
            entry.missing_kinds.includes("openapi"),
        ),
        true,
      );
    },
  ],
  [
    "/api/v1/review/enrichment-targets?target_type=surface-candidate&kind=openapi&limit=3",
    (body) => {
      assert.equal(body.data.targets.length <= 3, true);
      assert.equal(
        body.data.targets.every(
          (target) =>
            target.target_type === "surface-candidate" &&
            target.kind === "openapi",
        ),
        true,
      );
    },
  ],
  [
    "/api/v1/health",
    (body) => assert.equal(Array.isArray(body.data.subnets), true),
  ],
  [
    "/api/v1/incidents",
    (body) => {
      assert.equal(Array.isArray(body.data.surfaces), true);
      assert.equal(typeof body.data.summary.incident_count, "number");
    },
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
    "/api/v1/subnets/7/evidence?limit=3",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.claims.length <= 3, true);
    },
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
    "/api/v1/search-index?q=allways",
    (body) =>
      assert.equal(
        body.data.documents.length > 0 &&
          body.data.documents.every((document) => !("tokens" in document)),
        true,
      ),
  ],
  [
    "/api/v1/contracts",
    (body) => assert.equal(body.data.primary_domain, "api.metagraph.sh"),
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
  "/api/v1/review/enrichment-targets?target_type=unknown",
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

// #358: surface verify-now endpoint. A valid-format but unknown surface_id 404s
// at lookup, before any outbound probe, so this exercises routing + the error
// envelope without a network call. The probe/mapping path is covered by
// tests/surface-verify.test.mjs.
const verifyMissing = await handleRequest(
  new Request(
    "https://metagraph.sh/api/v1/surfaces/zzz-not-a-real-surface/verify",
  ),
  env,
  {},
);
assert.equal(
  verifyMissing.status,
  404,
  "verify on an unknown surface_id should 404 before probing",
);
assert.equal(
  verifyMissing.headers.get("x-metagraph-error-code"),
  "surface_not_found",
  "verify 404 should carry the surface_not_found error code",
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
