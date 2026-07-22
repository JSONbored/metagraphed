import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import {
  API_ROUTES,
  CONTRACT_VERSION,
  compileRoutePattern,
} from "../src/contracts.mjs";
import { handleRequest } from "../workers/api.mjs";
import {
  createLocalArtifactEnv,
  latestArtifactDate,
  readJson,
  repoRoot,
} from "./lib.mjs";
import { buildBlockFeed } from "../src/blocks.ts";
import { buildExtrinsicFeed } from "../src/extrinsics.ts";
import { buildAccountEvents } from "../src/account-events.ts";
import { buildSubnetMetagraph } from "../src/metagraph-neurons.ts";
import { buildSubnetHyperparams } from "../src/subnet-hyperparams.ts";
import { buildAccountIdentity } from "../src/account-identity.ts";
import { buildSubnetIdentityHistory } from "../src/subnet-identity-history.ts";
import { formatRpcUsage } from "../src/health-serving.ts";
import {
  BLOCK_PAGINATION,
  FEED_PAGINATION,
} from "../workers/request-params.ts";

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

const fixtureDetail = {
  schema_version: 1,
  generated_at: "1970-01-01T00:00:00.000Z",
  surface_id: "7:subnet-api:new_v2",
  netuid: 7,
  subnet_slug: "allways",
  subnet_name: "AllWays",
  kind: "subnet-api",
  captured_at: "2026-06-16T12:00:00.000Z",
  request: { method: "GET", url: "https://api.all-ways.io/health" },
  response: {
    status: 200,
    content_type: "application/json",
    body: { ok: true },
  },
};

// Register the OpenAPI components block ONCE under an absolute id (mirroring
// validate-schemas.mjs) instead of re-inlining all ~198 schemas into every
// per-route compile. Response schemas resolve their `#/components/...` refs
// against this single registered schema via an absolute `$ref`.
const COMPONENTS_ID = "https://metagraph.sh/openapi-components.schema.json";
ajv.addSchema(
  { $id: COMPONENTS_ID, components: openapi.components },
  COMPONENTS_ID,
);

// Rewrite every internal `#/components/...` reference to its absolute form so it
// resolves against the registered components schema. Pure structural transform —
// validation behaviour and error text are unchanged.
function absolutizeComponentRefs(node) {
  if (Array.isArray(node)) {
    return node.map(absolutizeComponentRefs);
  }
  if (node && typeof node === "object") {
    const out = {};
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

// Memoize compiled validators by their (rewritten) schema, so repeated routes
// and the shared ErrorEnvelope reuse one compiled function.
const responseValidatorCache = new Map();
function compileResponseValidator(schema) {
  const rewritten = absolutizeComponentRefs(schema);
  const key = JSON.stringify(rewritten);
  let validator = responseValidatorCache.get(key);
  if (!validator) {
    validator = ajv.compile(rewritten);
    responseValidatorCache.set(key, validator);
  }
  return validator;
}

// The chain-events routes proxy to the Postgres-backed data Worker (DATA_API
// service binding). It's a separate Worker not present in this harness, so mock it
// with the bare response shapes it serves (ADR 0013) — api.mjs rewraps them in the
// canonical envelope, which is what the checks below assert.
const baseEnv = createLocalArtifactEnv();
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
      if (/^\/api\/v1\/subnets\/\d+\/ownership-history$/.test(pathname)) {
        return new Response(
          JSON.stringify({
            schema_version: 1,
            netuid: 7,
            event_pallet: "SubtensorModule",
            event_method: "SubnetOwnerChanged",
            count: 0,
            ownership_changes: [],
          }),
          { status: 200, headers },
        );
      }
      if (/^\/api\/v1\/subnets\/\d+\/conviction$/.test(pathname)) {
        return new Response(
          JSON.stringify({
            schema_version: 1,
            netuid: 7,
            queried_at_block: 8647000,
            unlock_rate: 934866,
            maturity_rate: 311622,
            king: null,
            count: 0,
            leaderboard: [],
          }),
          { status: 200, headers },
        );
      }
      if (/^\/api\/v1\/subnets\/\d+\/lease\/history$/.test(pathname)) {
        return new Response(
          JSON.stringify({
            schema_version: 1,
            netuid: 7,
            event_pallet: "SubtensorModule",
            event_kinds: ["SubnetLeaseCreated", "SubnetLeaseTerminated"],
            count: 0,
            lease_events: [],
          }),
          { status: 200, headers },
        );
      }
      return new Response(
        JSON.stringify({ block_number: 100, count: 0, events: [] }),
        { status: 200, headers },
      );
    },
  },
  METAGRAPH_ARCHIVE: {
    async get(key) {
      if (key === "latest/fixtures/7:subnet-api:new_v2.json") {
        return {
          async json() {
            return fixtureDetail;
          },
        };
      }
      return baseEnv.METAGRAPH_ARCHIVE.get(key);
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
    "/api/v1/subnets/7/performance",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.neuron_count, "number");
      // Cold D1 → schema-stable null blocks; with rows → metric objects.
      assert.ok(
        body.data.incentive === null || typeof body.data.incentive === "object",
      );
      assert.ok(
        body.data.trust === null || typeof body.data.trust === "object",
      );
    },
  ],
  [
    "/api/v1/subnets/7/idle-stake",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(typeof body.data.neuron_count, "number");
      assert.equal(typeof body.data.idle_neuron_count, "number");
      assert.equal(typeof body.data.idle_stake_tao, "number");
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
    "/api/v1/subnets/7/performance/history?window=7d",
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
    "/api/v1/subnets/7/stake-flow?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_staked_tao, "number");
      assert.equal(typeof body.data.total_unstaked_tao, "number");
      assert.equal(typeof body.data.net_flow_tao, "number");
      assert.equal(typeof body.data.stake_events, "number");
      assert.equal(typeof body.data.unstake_events, "number");
    },
  ],
  [
    "/api/v1/subnets/7/volume",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "24h");
      assert.equal(typeof body.data.buy_volume_alpha, "number");
      assert.equal(typeof body.data.sell_volume_alpha, "number");
      assert.equal(typeof body.data.total_volume_alpha, "number");
      assert.equal(typeof body.data.net_volume_alpha, "number");
      assert.ok(
        body.data.sentiment_ratio === null ||
          typeof body.data.sentiment_ratio === "number",
      );
      assert.ok(
        ["bullish", "bearish", "neutral"].includes(body.data.sentiment),
      );
      assert.ok(
        body.data.vol_mcap_ratio === null ||
          typeof body.data.vol_mcap_ratio === "number",
      );
    },
  ],
  [
    "/api/v1/subnets/7/ohlc?interval=1h",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.interval, "1h");
      assert.equal(Array.isArray(body.data.candles), true);
      assert.equal(body.data.root_excluded, false);
    },
  ],
  [
    "/api/v1/subnets/7/stake-quote?amount=1000&direction=stake",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.direction, "stake");
      assert.ok(["alpha", "tao"].includes(body.data.expected_out_unit));
      assert.equal(typeof body.data.expected_out, "number");
      assert.equal(typeof body.data.spot_price_tao, "number");
      assert.equal(typeof body.data.effective_price_tao, "number");
      assert.equal(typeof body.data.price_impact_pct, "number");
      assert.equal(typeof body.data.is_root, "boolean");
    },
  ],
  [
    "/api/v1/subnets/7/weights?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_setters, "number");
      assert.equal(typeof body.data.weight_sets, "number");
      assert.equal(
        body.data.sets_per_setter === null ||
          typeof body.data.sets_per_setter === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/weights/setters?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_setters, "number");
      assert.equal(typeof body.data.weight_sets, "number");
      assert.equal(typeof body.data.setter_count, "number");
      assert.equal(Array.isArray(body.data.setters), true);
    },
  ],
  [
    "/api/v1/subnets/7/serving?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_servers, "number");
      assert.equal(typeof body.data.announcements, "number");
      assert.equal(
        body.data.announcements_per_server === null ||
          typeof body.data.announcements_per_server === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/prometheus?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_exporters, "number");
      assert.equal(typeof body.data.announcements, "number");
      assert.equal(
        body.data.announcements_per_exporter === null ||
          typeof body.data.announcements_per_exporter === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/stake-moves?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_movers, "number");
      assert.equal(typeof body.data.movements, "number");
      assert.equal(
        body.data.movements_per_mover === null ||
          typeof body.data.movements_per_mover === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/stake-transfers?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_senders, "number");
      assert.equal(typeof body.data.transfers, "number");
      assert.equal(
        body.data.transfers_per_sender === null ||
          typeof body.data.transfers_per_sender === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/registrations?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_registrants, "number");
      assert.equal(typeof body.data.registrations, "number");
      assert.equal(
        body.data.registrations_per_registrant === null ||
          typeof body.data.registrations_per_registrant === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/axon-removals?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_removers, "number");
      assert.equal(typeof body.data.removals, "number");
      assert.equal(
        body.data.removals_per_remover === null ||
          typeof body.data.removals_per_remover === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/7/deregistrations?window=30d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.distinct_deregistered_hotkeys, "number");
      assert.equal(typeof body.data.deregistrations, "number");
      assert.equal(
        body.data.deregistrations_per_hotkey === null ||
          typeof body.data.deregistrations_per_hotkey === "number",
        true,
      );
    },
  ],
  [
    "/api/v1/subnets/movers?window=30d&sort=stake&limit=10",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(body.data.sort, "stake");
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(Array.isArray(body.data.movers), true);
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
    "/api/v1/subnets/7/identity-history?limit=5",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.entries), true);
      assert.equal(body.data.entries.length <= 5, true);
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
    "/api/v1/subnets/7/hyperparameters",
    (body) => {
      assert.equal(body.data.netuid, 7);
      // Cold harness (no D1) → hyperparameters present but null; never 404.
      assert.equal("hyperparameters" in body.data, true);
    },
  ],
  [
    "/api/v1/subnets/7/hyperparameters/history?limit=5",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.entries), true);
      assert.equal(body.data.entries.length <= 5, true);
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
    "/api/v1/subnets/7/yield",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.neurons), true);
      assert.equal(typeof body.data.neuron_count, "number");
      assert.equal(typeof body.data.validator_count, "number");
      assert.equal(typeof body.data.miner_count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/yield/history?window=7d",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
    },
  ],
  [
    "/api/v1/validators?sort=uid_count&limit=3",
    (body) => {
      assert.equal(body.data.sort, "uid_count");
      assert.equal(body.data.limit, 3);
      assert.equal(Array.isArray(body.data.validators), true);
      assert.equal(typeof body.data.validator_count, "number");
    },
  ],
  [
    "/api/v1/accounts?sort=uid_count&limit=3",
    (body) => {
      assert.equal(body.data.sort, "uid_count");
      assert.equal(body.data.limit, 3);
      assert.equal(Array.isArray(body.data.accounts), true);
      assert.equal(typeof body.data.account_count, "number");
    },
  ],
  [
    "/api/v1/accounts/top-holders?sort=free_tao&limit=3",
    (body) => {
      assert.equal(body.data.sort, "free_tao");
      assert.equal(body.data.limit, 3);
      assert.equal(Array.isArray(body.data.accounts), true);
      assert.equal(typeof body.data.account_count, "number");
    },
  ],
  [
    "/api/v1/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    (body) => {
      assert.equal(
        body.data.hotkey,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      // Cold harness (no D1) → zeroed aggregate, never 404.
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/nominators",
    (body) => {
      assert.equal(
        body.data.hotkey,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      // Cold harness (no D1) → empty list, never 404.
      assert.equal(Array.isArray(body.data.nominators), true);
      assert.equal(typeof body.data.nominator_count, "number");
    },
  ],
  [
    "/api/v1/validators/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/history?window=30d",
    (body) => {
      assert.equal(
        body.data.hotkey,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      // Cold harness (no D1) → empty points, never 404.
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
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
    "/api/v1/subnets/7/event-summary",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.categories), true);
      assert.equal(Array.isArray(body.data.event_kinds), true);
      assert.equal(Array.isArray(body.data.recent_events), true);
      assert.equal(typeof body.data.total_events, "number");
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
      assert.equal(Array.isArray(body.data.labels), true);
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/entities",
    (body) => {
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(Array.isArray(body.data.labels), true);
      assert.equal(typeof body.data.ownership_tie_count, "number");
      assert.equal(Array.isArray(body.data.ownership_ties), true);
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
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/stake-flow?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.net_flow_tao, "number");
      assert.equal(typeof body.data.gross_flow_tao, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/stake-moves?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_movements, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/weight-setters?window=7d",
    (body) => {
      assert.equal(body.data.window, "7d");
      assert.equal(typeof body.data.total_weight_sets, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/registrations?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_registrations, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/serving?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_announcements, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/axon-removals?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_removals, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/prometheus?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_announcements, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/deregistrations?window=30d",
    (body) => {
      assert.equal(body.data.window, "30d");
      assert.equal(typeof body.data.total_deregistrations, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
      assert.equal(typeof body.data.subnet_count, "number");
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
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/portfolio",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(Array.isArray(body.data.positions), true);
      assert.equal(typeof body.data.position_count, "number");
      assert.ok(
        body.data.stake_concentration === null ||
          typeof body.data.stake_concentration === "object",
      );
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/positions",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(Array.isArray(body.data.positions), true);
      assert.equal(typeof body.data.position_count, "number");
      assert.equal(typeof body.data.total_stake_tao, "number");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/subnets/7/history?window=30d",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(body.data.netuid, 7);
      assert.equal(body.data.window, "30d");
      assert.equal(Array.isArray(body.data.points), true);
      assert.equal(typeof body.data.point_count, "number");
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
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/root-claim",
    (body) => {
      assert.equal(
        body.data.ss58,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal("claim_type" in body.data, true);
      assert.equal("hotkeys" in body.data, true);
      assert.ok(body.data.hotkeys === null || Array.isArray(body.data.hotkeys));
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/children",
    (body) => {
      assert.equal(
        body.data.account,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.ok(body.data.subnets === null || Array.isArray(body.data.subnets));
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/parents",
    (body) => {
      assert.equal(
        body.data.account,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.ok(body.data.subnets === null || Array.isArray(body.data.subnets));
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/identity",
    (body) => {
      assert.equal(
        body.data.account,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(typeof body.data.has_identity, "boolean");
    },
  ],
  [
    "/api/v1/accounts/5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5/identity-history?limit=5",
    (body) => {
      assert.equal(
        body.data.account,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      assert.equal(Array.isArray(body.data.entries), true);
      assert.equal(body.data.entries.length <= 5, true);
    },
  ],
  [
    "/api/v1/sudo/key",
    (body) => {
      assert.equal("hotkey" in body.data, true);
    },
  ],
  [
    "/api/v1/network/parameters",
    (body) => {
      assert.equal("tao_weight" in body.data, true);
      assert.equal("stake_threshold_tao" in body.data, true);
      assert.equal("pending_childkey_cooldown_blocks" in body.data, true);
    },
  ],
  [
    "/api/v1/evm/address/0x0000000000000000000000000000000000000001",
    (body) => {
      assert.equal(
        body.data.h160,
        "0x0000000000000000000000000000000000000001",
      );
      assert.equal("ss58" in body.data, true);
    },
  ],
  [
    "/api/v1/network/randomness",
    (body) => {
      assert.equal("last_stored_round" in body.data, true);
      assert.equal("oldest_stored_round" in body.data, true);
      assert.equal("stored_round_span" in body.data, true);
    },
  ],
  [
    "/api/v1/subnets/7/recycled",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal("recycled_tao" in body.data, true);
    },
  ],
  [
    "/api/v1/subnets/7/burn",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal("burn_tao" in body.data, true);
    },
  ],
  [
    "/api/v1/subnets/7/ownership-history",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.ownership_changes), true);
      assert.equal(typeof body.data.count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/conviction",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.leaderboard), true);
      assert.equal(typeof body.data.count, "number");
    },
  ],
  [
    "/api/v1/subnets/7/lease",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.ok(
        body.data.leased === null || typeof body.data.leased === "boolean",
      );
    },
  ],
  [
    "/api/v1/subnets/7/lease/history",
    (body) => {
      assert.equal(body.data.netuid, 7);
      assert.equal(Array.isArray(body.data.lease_events), true);
      assert.equal(typeof body.data.count, "number");
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
    "/api/v1/blocks/summary",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.block_count, "number");
      // block_time / throughput are an object or null on a cold store.
      assert.ok(
        body.data.block_time === null ||
          typeof body.data.block_time === "object",
      );
      assert.ok(
        body.data.throughput === null ||
          typeof body.data.throughput === "object",
      );
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
    "/api/v1/sudo",
    (body) => {
      assert.equal(Array.isArray(body.data.extrinsics), true);
      assert.equal(typeof body.data.extrinsic_count, "number");
    },
  ],
  [
    "/api/v1/governance/config-changes",
    (body) => {
      assert.equal(Array.isArray(body.data.extrinsics), true);
      assert.equal(typeof body.data.extrinsic_count, "number");
    },
  ],
  [
    "/api/v1/runtime",
    (body) => {
      assert.equal(Array.isArray(body.data.transitions), true);
      assert.equal(typeof body.data.transition_count, "number");
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
    "/api/v1/chain/transfers?window=7d&limit=5",
    (body) => {
      assert.equal(typeof body.data.total_volume_tao, "number");
      assert.equal(typeof body.data.transfer_count, "number");
      assert.equal(Array.isArray(body.data.top_senders), true);
      assert.equal(Array.isArray(body.data.top_receivers), true);
    },
  ],
  [
    "/api/v1/chain/transfer-pairs?window=7d&limit=5",
    (body) => {
      assert.equal(typeof body.data.total_volume_tao, "number");
      assert.equal(typeof body.data.transfer_count, "number");
      assert.equal(typeof body.data.unique_pairs, "number");
      assert.equal(Array.isArray(body.data.pairs), true);
    },
  ],
  [
    "/api/v1/chain/stake-flow?window=7d&limit=5",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.net_flow_distribution === null ||
          typeof body.data.net_flow_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/alpha-volume?limit=5",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.window, "24h");
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.volume_distribution === null ||
          typeof body.data.volume_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
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
    "/api/v1/chain/weights",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/weights/setters",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.distinct_setters, "number");
      assert.equal(typeof body.data.weight_sets, "number");
      assert.equal(typeof body.data.setter_count, "number");
      assert.equal(Array.isArray(body.data.setters), true);
    },
  ],
  [
    "/api/v1/chain/serving",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/prometheus",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/axon-removals",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/registrations",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/deregistrations",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/stake-moves",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/stake-transfers",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.network, "object");
      assert.equal(typeof body.data.network.transfers, "number");
      assert.equal(
        body.data.intensity_distribution === null ||
          typeof body.data.intensity_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/performance",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.neuron_count, "number");
      // each lens is a metrics/distribution object or null on a cold store.
      assert.equal(
        body.data.incentive === null || typeof body.data.incentive === "object",
        true,
      );
      assert.equal(
        body.data.trust === null || typeof body.data.trust === "object",
        true,
      );
    },
  ],
  [
    "/api/v1/chain/idle-stake",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.total_idle_stake_tao, "number");
      assert.equal(Array.isArray(body.data.subnets), true);
    },
  ],
  [
    "/api/v1/chain/identity-history",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.count, "number");
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(Array.isArray(body.data.changes), true);
    },
  ],
  [
    "/api/v1/chain/yield",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.neuron_count, "number");
      // aggregate yield + distribution are a number/object or null on cold store.
      assert.equal(
        body.data.network_yield === null ||
          typeof body.data.network_yield === "number",
        true,
      );
      assert.equal(
        body.data.distribution === null ||
          typeof body.data.distribution === "object",
        true,
      );
    },
  ],
  [
    "/api/v1/chain/concentration",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.neuron_count, "number");
      assert.equal(typeof body.data.entity_count, "number");
      // each lens is a metrics object or null on a cold store.
      assert.equal(
        body.data.stake === null || typeof body.data.stake === "object",
        true,
      );
    },
  ],
  [
    "/api/v1/chain/turnover",
    (body) => {
      assert.equal(body.data.schema_version, 1);
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(typeof body.data.comparable, "boolean");
      assert.equal(typeof body.data.network, "object");
      assert.equal(
        body.data.stability_distribution === null ||
          typeof body.data.stability_distribution === "object",
        true,
      );
      assert.equal(Array.isArray(body.data.subnets), true);
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
    "/api/v1/compare/validators?hotkeys=5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    (body) => {
      assert.equal(Array.isArray(body.data.validators), true);
      assert.equal(body.data.validators.length, 1);
      assert.equal(
        body.data.validators[0].hotkey,
        "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      );
      // Cold harness (no D1/Postgres) → zeroed detail, never 404.
      assert.equal(body.data.validators[0].subnet_count, 0);
      assert.equal(body.data.netuid, null);
      assert.equal(typeof body.data.validator_count, "number");
    },
  ],
  [
    "/api/v1/domains",
    (body) => {
      assert.equal(typeof body.data.domain_count, "number");
      assert.equal(Array.isArray(body.data.domains), true);
      assert.equal(body.data.domains.length, body.data.domain_count);
    },
  ],
  [
    "/api/v1/domains/inference/summary",
    (body) => {
      assert.equal(body.data.domain, "inference");
      assert.equal(typeof body.data.subnet_count, "number");
      assert.equal(Array.isArray(body.data.netuids), true);
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
    "/api/v1/fixtures/7:subnet-api:new_v2",
    (body) => {
      assert.equal(body.data.surface_id, "7:subnet-api:new_v2");
      assert.equal(body.data.response.status, 200);
      assert.deepEqual(body.data.response.body, { ok: true });
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
    CONTRACT_VERSION,
    `${route}: missing contract header`,
  );
  const body = await response.json();
  assert.equal(body.ok, true, `${route}: expected ok envelope`);
  assert.equal(body.schema_version, 1, `${route}: expected schema_version 1`);
  validateWorkerResponse(route, body);
  assertion(body);
}

// #6359: production wrangler.jsonc flips eight METAGRAPH_*_SOURCE flags to
// "postgres", so the live Worker serves these routes via tryPostgresTier →
// DATA_API. The cold harness above never sets those flags, so AJV only saw the
// D1/empty fallback. Validate one representative route per flag with a DATA_API
// mock whose body is built by the same src/* builders workers/data-api.mjs uses.
{
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const OBSERVED_AT_MS = 1_750_009_000_000;
  const BLOCK_NUM = 1_000_000;
  const HASH = `0x${"a".repeat(64)}`;
  const IDENTITY_HASH = "a".repeat(64);

  const blockRow = {
    block_number: BLOCK_NUM,
    block_hash: HASH,
    parent_hash: `0x${"b".repeat(64)}`,
    author: "5AuthorExample12345678901234567890123456789012",
    extrinsic_count: 5,
    event_count: 20,
    spec_version: 201,
    observed_at: OBSERVED_AT_MS,
  };
  const extrinsicRow = {
    block_number: BLOCK_NUM,
    extrinsic_index: 2,
    extrinsic_hash: HASH,
    signer: SS58,
    call_module: "SubtensorModule",
    call_function: "add_stake",
    call_args: null,
    fee_tao: 0.0125,
    tip_tao: 0,
    success: 1,
    observed_at: OBSERVED_AT_MS,
  };
  const accountEventRow = {
    block_number: BLOCK_NUM,
    event_index: 1,
    event_kind: "StakeAdded",
    hotkey: SS58,
    coldkey: null,
    netuid: 7,
    uid: 3,
    amount_tao: 1.5,
    alpha_amount: null,
    observed_at: OBSERVED_AT_MS,
    extrinsic_index: 2,
  };
  const neuronRow = {
    uid: 3,
    hotkey: SS58,
    coldkey: "5ColdkeyExample123456789012345678901234567890",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    validator_trust: 0.8,
    consensus: 0.7,
    incentive: 0.6,
    dividends: 0.4,
    emission_tao: 1.23,
    stake_tao: 456.7,
    registered_at_block: 100,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    take: null,
    block_number: BLOCK_NUM,
    captured_at: OBSERVED_AT_MS,
  };
  const hyperparamsRow = {
    netuid: 7,
    tempo: 360,
    registration_allowed: 1,
    commit_reveal_enabled: 0,
    liquid_alpha_enabled: 0,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 0,
    owner_cut_auto_lock_enabled: 0,
    block_number: BLOCK_NUM,
    captured_at: OBSERVED_AT_MS,
  };
  const identityRow = {
    account: SS58,
    name: "Example Operator",
    url: "https://example.com",
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
    captured_at: OBSERVED_AT_MS,
  };
  const identityHistoryRow = {
    block_number: BLOCK_NUM,
    observed_at: OBSERVED_AT_MS,
    subnet_name: "Example Subnet",
    symbol: null,
    description: null,
    github_repo: null,
    subnet_url: null,
    discord: null,
    logo_url: null,
    identity_hash: IDENTITY_HASH,
  };

  const postgresTierChecks = [
    {
      flag: "METAGRAPH_BLOCKS_SOURCE",
      route: "/api/v1/blocks",
      upstreamPath: "/api/v1/blocks",
      data: buildBlockFeed([blockRow], {
        limit: BLOCK_PAGINATION.defaultLimit,
        offset: 0,
        nextCursor: null,
      }),
      assertion: (body) =>
        assert.equal(body.data.blocks[0].block_number, BLOCK_NUM),
    },
    {
      flag: "METAGRAPH_EXTRINSICS_SOURCE",
      route: "/api/v1/extrinsics",
      upstreamPath: "/api/v1/extrinsics",
      data: buildExtrinsicFeed([extrinsicRow], {
        limit: BLOCK_PAGINATION.defaultLimit,
        offset: 0,
        nextCursor: null,
      }),
      assertion: (body) => assert.equal(body.data.extrinsics[0].signer, SS58),
    },
    {
      flag: "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      route: `/api/v1/accounts/${SS58}/events`,
      upstreamPath: `/api/v1/accounts/${SS58}/events`,
      data: buildAccountEvents([accountEventRow], SS58, {
        limit: FEED_PAGINATION.defaultLimit,
        offset: 0,
        nextCursor: null,
      }),
      assertion: (body) => assert.equal(body.data.events[0].netuid, 7),
    },
    {
      flag: "METAGRAPH_NEURONS_SOURCE",
      route: "/api/v1/subnets/7/metagraph",
      upstreamPath: "/api/v1/subnets/7/metagraph",
      data: buildSubnetMetagraph([neuronRow], 7),
      assertion: (body) => assert.equal(body.data.neurons[0].uid, 3),
    },
    {
      flag: "METAGRAPH_SUBNET_HYPERPARAMS_SOURCE",
      route: "/api/v1/subnets/7/hyperparameters",
      upstreamPath: "/api/v1/subnets/7/hyperparameters",
      data: buildSubnetHyperparams(hyperparamsRow, 7),
      assertion: (body) => assert.equal(body.data.hyperparameters.tempo, 360),
    },
    {
      flag: "METAGRAPH_ACCOUNT_IDENTITY_SOURCE",
      route: `/api/v1/accounts/${SS58}/identity`,
      upstreamPath: `/api/v1/accounts/${SS58}/identity`,
      data: buildAccountIdentity(identityRow, SS58),
      assertion: (body) => assert.equal(body.data.name, "Example Operator"),
    },
    {
      flag: "METAGRAPH_SUBNET_IDENTITY_SOURCE",
      route: "/api/v1/subnets/7/identity-history?limit=5",
      upstreamPath: "/api/v1/subnets/7/identity-history?limit=5",
      data: buildSubnetIdentityHistory([identityHistoryRow], 7, {
        limit: 5,
        offset: 0,
        nextCursor: null,
      }),
      assertion: (body) =>
        assert.equal(body.data.entries[0].identity_hash, IDENTITY_HASH),
    },
    {
      flag: "METAGRAPH_RPC_USAGE_SOURCE",
      route: "/api/v1/rpc/usage",
      upstreamPath: "/api/v1/rpc/usage",
      data: formatRpcUsage({
        window: "7d",
        observedAt: new Date(OBSERVED_AT_MS).toISOString(),
        totals: {
          total: 10,
          ok_count: 9,
          failover_count: 1,
          cache_hits: 2,
          avg_latency_ms: 25,
        },
        latency: { p50: 20, p95: 40 },
        endpointRows: [
          {
            endpoint_id: "finney-primary",
            provider: "example",
            requests: 10,
            ok_count: 9,
            avg_latency_ms: 25,
          },
        ],
        networkRows: [{ network: "finney", requests: 10, ok_count: 9 }],
        bucketRows: [
          { ts: OBSERVED_AT_MS, requests: 10, errors: 1, avg_latency_ms: 25 },
        ],
        bucketGranularity: "1h",
      }),
      assertion: (body) => assert.equal(body.data.summary.total_requests, 10),
    },
  ];

  assert.equal(
    postgresTierChecks.length,
    8,
    "postgres-tier AJV coverage must include all 8 production SOURCE flags",
  );

  for (const {
    flag,
    route,
    upstreamPath,
    data,
    assertion,
  } of postgresTierChecks) {
    let capturedPath = null;
    const postgresEnv = createLocalArtifactEnv({
      [flag]: "postgres",
      DATA_API: {
        async fetch(request) {
          const url = new URL(request.url);
          capturedPath = `${url.pathname}${url.search}`;
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const response = await handleRequest(
      new Request(`https://metagraph.sh${route}`),
      postgresEnv,
      {},
    );
    assert.equal(response.status, 200, `${flag} ${route}: expected 200`);
    assert.equal(
      capturedPath,
      upstreamPath,
      `${flag}: DATA_API must receive the forwarded path`,
    );
    const body = await response.json();
    assert.equal(body.ok, true, `${flag} ${route}: expected ok envelope`);
    assert.equal(body.schema_version, 1, `${flag} ${route}: schema_version`);
    validateWorkerResponse(route, body);
    assertion(body);
  }

  console.log(
    `Validated ${postgresTierChecks.length} Postgres-tier Worker API route(s).`,
  );
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
              contract_version: CONTRACT_VERSION,
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

  const validator = compileResponseValidator(responseSchema);
  assert.equal(
    validator(body),
    true,
    `${route}: Worker response must match generated OpenAPI schema: ${ajv.errorsText(
      validator.errors,
    )}`,
  );
}

function validateErrorEnvelope(body) {
  const validator = compileResponseValidator({
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
