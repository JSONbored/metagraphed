// Every serve-time overlay, run over its artifact, parsed against the schema
// the route publishes.
//
// ## THE DEFECT CLASS
//
// A published artifact is built by one producer and validated against its
// component at build time. Then the serve path OVERLAYS it -- live health,
// live prices, live freshness -- and serves the composed result. The overlay
// writes keys. If a key it writes is not declared, the served response does
// not match the published contract.
//
// That was survivable while every artifact schema was `.passthrough()`: an
// undeclared key was served and nobody noticed. #10853 flipped them to
// `.strict()`, which turned the same latent drift into a REFUSAL -- the
// response-validation tripwire throws, and the route 500s on every request.
//
// Four separate outages in the fortnight before this file existed, all the
// same shape, all found in production rather than in CI:
//
//   - agent-catalog          overlayCatalogIndex/Detail stamped
//                            `operational_observed_at`/`health_source`
//   - rpc/endpoints          the endpoint overlay's health vocabulary
//   - subnet-profiles        `promoted_at`/`promoted_by`
//   - economics (#10935)     withAlphaUsdEconomics stamped the four
//                            `alpha_*_usd` twins onto every row
//
// Each was fixed by declaring the fields the overlay writes. None of those
// fixes could see the next one, because each was a fix to one schema and the
// thing they have in common is not a schema -- it is that NOTHING RAN THE
// OVERLAY AND PARSED THE RESULT.
//
// #9138 built exactly that check for one overlay
// (tests/rpc-pool-overlay-schema-conformance.test.ts, and its header is worth
// reading -- it is this file's ancestor). This is that idea swept across every
// overlay the serve path has.
//
// ## WHY IT PARSES INSTEAD OF ASSERTING VALUES
//
// A test that asserted `composed.health_source === "live-cron-prober"` would
// have passed throughout all four outages: it re-encodes the overlay's own
// assumption instead of checking it against the contract. The only thing that
// catches an UNDECLARED key is parsing against the declaration -- so every
// entry below runs the real composer and hands its real output to the real
// component schema.
//
// ## THE THREE ASSERTIONS, AND WHY EACH IS LOAD-BEARING
//
//   1. the baked fixture parses         -- a fixture that was already invalid
//                                          would make (2) fail for a reason
//                                          that is not the overlay's, and
//                                          would read as a false alarm
//   2. the composed output parses       -- THE CHECK
//   3. the overlay actually ran         -- `provesLive` names a key the
//                                          overlay must have written. Without
//                                          it, a composer that silently
//                                          stopped overlaying would still pass
//                                          (2), on the baked value, and this
//                                          file would be asserting nothing
//                                          about the composition
//
// Plus a VACUITY guard at the bottom: a deliberately-drifted composition must
// be REFUSED. If the parse could not fail, all three assertions above would
// pass on anything and the sweep would be decoration.
//
// ## THE COMPONENT IS LOOKED UP, NOT NAMED
//
// An entry declares `routeId`, and the component id is resolved through the
// SAME chain production uses -- `API_ROUTES` -> `artifact_path` ->
// `schemaRefForArtifactPath` -> `COMPONENT_SCHEMAS_BY_ID`. So an entry cannot
// quietly test against the wrong schema, and a route repointed at a different
// artifact re-points its sweep entry with it. Row-level composers (an overlay
// whose whole delta is one nested value) declare `component` directly, since
// no route publishes that value on its own.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import * as healthServing from "../src/health-serving.ts";
import * as alphaUsdOverlay from "../src/alpha-usd-overlay.ts";
import { API_ROUTES, schemaRefForArtifactPath } from "../src/contracts.ts";
import { COMPONENT_SCHEMAS_BY_ID } from "../schemas-src/openapi-registry.ts";
import type { SubnetEconomics } from "../schemas-src/shared.ts";
import type { TaoUsdReading } from "../src/alpha-usd.ts";
import type { z } from "zod";

type Row = Record<string, unknown>;

// ── Resolution: a route id becomes the schema that route publishes ──────────

function componentForRoute(routeId: string): string {
  const route = (API_ROUTES as unknown as Row[]).find(
    (entry) => entry.id === routeId,
  );
  assert.ok(route, `no API_ROUTES entry with id "${routeId}"`);
  return schemaRefForArtifactPath(route.artifact_path as string);
}

function schemaFor(componentId: string): z.ZodType {
  const schema = COMPONENT_SCHEMAS_BY_ID.get(componentId);
  assert.ok(
    schema,
    `component "${componentId}" is not registered -- the sweep would parse ` +
      "against nothing and pass on anything",
  );
  return schema as z.ZodType;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// MINIMAL BUT COMPLETE: required fields only, so a schema that grows a new
// required field fails assertion (1) with "the fixture is stale" rather than
// blaming the overlay. Optional fields are added only where an overlay reads
// them.

const RUN_AT = "2026-08-12T09:00:00.000Z";
const BUILT_AT = "2026-08-12T00:00:00.000Z";

/** A live 15-minute cron snapshot, in the shape resolveLiveHealth returns. */
function liveSnapshot(overrides: Row = {}): Row {
  return {
    generated_at: RUN_AT,
    last_run_at: RUN_AT,
    health_source: "live-cron-prober",
    summary: { surface_count: 1, status_counts: { ok: 1 } },
    subnets: [
      {
        netuid: 1,
        status: "ok",
        surface_count: 1,
        ok_count: 1,
        degraded_count: 0,
        failed_count: 0,
        unknown_count: 0,
      },
    ],
    surfaces: [
      {
        surface_id: "sn1-api",
        netuid: 1,
        kind: "subnet-api",
        provider: "example",
        url: "https://sn1.example/api",
        status: "ok",
        classification: "live",
        latency_ms: 91,
        last_checked: RUN_AT,
        last_ok: RUN_AT,
      },
    ],
    ...overrides,
  };
}

function endpointResource(overrides: Row = {}): Row {
  return {
    auth_required: false,
    health_source: "probe-derived",
    health_stale: false,
    id: "sn1-api",
    kind: "subnet-api",
    last_ok: BUILT_AT,
    layer: "subnet-app",
    monitoring_policy: {
      enabled: true,
      expect: "http-200",
      method: "GET",
      source: "registry",
    },
    monitoring_status: "monitored",
    netuid: 1,
    observed_at: BUILT_AT,
    operator: "example",
    pool_eligible: false,
    provider: "example",
    public_safe: true,
    publication_state: "monitored",
    score: 70,
    status: "degraded",
    surface_id: "sn1-api",
    surface_key: "sn1-api",
    url: "https://sn1.example/api",
    ...overrides,
  };
}

// Typed to the CONTRACT, not to a bag: the economics composers declare
// `SubnetEconomics` in and out (#10782), so a fixture that drifts from the row
// type fails at the compiler rather than at the parse.
function economicsRow(overrides: Row = {}): SubnetEconomics {
  return {
    alpha_fdv_tao: 1000,
    alpha_in_pool: 500,
    alpha_market_cap_tao: 800,
    alpha_out_pool: 300,
    alpha_price_tao: 0.04,
    emission_share: 0.01,
    max_stake_alpha: 10_000,
    max_uids: 256,
    max_validators: 64,
    miner_count: 100,
    name: "Example",
    netuid: 1,
    owner_coldkey: null,
    owner_hotkey: null,
    registration_allowed: true,
    registration_cost_tao: 1.5,
    slug: "example",
    subnet_volume_tao: 42,
    tao_in_pool_tao: 20,
    total_stake_alpha: 900,
    validator_count: 64,
    ...overrides,
  };
}

function economicsBlob(overrides: Row = {}): Row {
  return {
    generated_at: BUILT_AT,
    schema_version: 1,
    captured_at: BUILT_AT,
    network: "finney",
    subnets: [economicsRow()],
    summary: {
      registration_open_count: 1,
      subnet_count: 1,
      // Fixed-9-decimal strings, not numbers: these are RAO-precision totals
      // the schema pins with a regex, and JSON numbers would lose the tail.
      total_alpha_value_tao: "900.000000000",
      total_miners: 100,
      total_network_value_tao: "1000.000000000",
      total_root_value_tao: "0.000000000",
      total_stake_alpha: "900.000000000",
      total_validators: 64,
      with_economics_count: 1,
    },
    ...overrides,
  };
}

/** A TAO/USD reading fresh enough for the alpha-USD overlay to price with. */
function taoUsdReading(): TaoUsdReading {
  return {
    usd_per_tao: 300,
    block_number: 5_000_000,
    observed_at: RUN_AT,
    price_basis: "index",
  };
}

function volumeRow(overrides: Row = {}): Row {
  return {
    schema_version: 1,
    netuid: 1,
    window: "24h",
    buy_volume_alpha: 10,
    sell_volume_alpha: 8,
    total_volume_alpha: 18,
    buy_volume_tao: 4,
    sell_volume_tao: 3,
    total_volume_tao: 7,
    buy_count: 5,
    sell_count: 4,
    net_volume_alpha: 2,
    sentiment_ratio: 0.55,
    sentiment: "bullish",
    vol_mcap_ratio: 0.01,
    ...overrides,
  };
}

function rpcPoolEndpoint(id: string, overrides: Row = {}): Row {
  return {
    id,
    url: `https://${id}.example`,
    provider: "example",
    status: "ok",
    score: 80,
    pool_eligible: true,
    observed_at: BUILT_AT,
    health_source: "probe-derived",
    health_stale: false,
    last_ok: BUILT_AT,
    ...overrides,
  };
}

/** A live rpc-pool snapshot -- a different KV key from the surface snapshot. */
function liveRpcPool(): Row {
  return {
    generated_at: RUN_AT,
    last_run_at: RUN_AT,
    endpoints: [
      {
        id: "rpc-a",
        status: "ok",
        classification: "live",
        latency_ms: 55,
        last_checked: RUN_AT,
        last_ok: RUN_AT,
      },
    ],
  };
}

// ── The sweep table ────────────────────────────────────────────────────────

type SweepEntry = {
  /** The exported composer's name -- what the inventory guard matches on. */
  composer: string;
  /** The route whose published component the output must satisfy. */
  routeId?: string;
  /** For a row-level composer: the component its output IS. */
  component?: string;
  /** The artifact as built, before the overlay. Must parse on its own. */
  baked: () => unknown;
  /** Run the real composer over `baked()` and return what the route serves. */
  compose: (baked: never) => unknown;
  /**
   * Names a value only the LIVE branch can produce. Guards the guard: without
   * it a composer that stopped overlaying would still parse, on the baked
   * value, and this entry would prove nothing about the composition.
   */
  provesLive: (composed: never) => unknown;
  /** What the live branch must have written -- compared against provesLive. */
  expected: unknown;
};

const SWEEP: SweepEntry[] = [
  {
    composer: "overlaySubnetHealth",
    routeId: "subnet-health",
    baked: () => ({
      schema_version: 1,
      netuid: 1,
      summary: {
        status: "unknown",
        surface_count: 0,
        ok_count: 0,
        degraded_count: 0,
        failed_count: 0,
        unknown_count: 0,
      },
      surfaces: [],
    }),
    compose: (baked: Row) =>
      healthServing.overlaySubnetHealth(baked, liveSnapshot(), 1),
    provesLive: (composed: Row) => (composed.surfaces as Row[])[0]?.observed_by,
    expected: "live-cron-prober",
  },
  {
    composer: "buildGlobalHealth",
    routeId: "health",
    baked: () => ({
      schema_version: 1,
      global: { surface_count: 0, status_counts: {} },
      subnets: [],
    }),
    compose: (baked: Row) =>
      healthServing.buildGlobalHealth(liveSnapshot(), baked),
    provesLive: (composed: Row) => composed.operational_observed_at,
    expected: RUN_AT,
  },
  {
    composer: "mergeRpcEndpoints",
    routeId: "rpc-endpoints",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      summary: { endpoint_count: 1 },
      endpoints: [
        {
          id: "rpc-a",
          kind: "subtensor-rpc",
          url: "https://rpc-a.example",
          provider: "example",
          status: "degraded",
          classification: "transient",
          network: "finney",
          chain: "bittensor",
          observed_at: BUILT_AT,
          health_source: "probe-derived",
          health_stale: false,
          last_ok: BUILT_AT,
        },
      ],
    }),
    compose: (baked: Row) =>
      healthServing.mergeRpcEndpoints(baked, liveRpcPool()),
    provesLive: (composed: Row) => (composed.endpoints as Row[])[0]?.status,
    expected: "ok",
  },
  {
    composer: "overlayRpcPoolEligibility",
    // Row-level: the overlay rewrites ONE pool, and no route publishes a pool
    // on its own -- /api/v1/rpc/pools serves them inside `pools[]`.
    component: "RpcPool",
    baked: () => ({
      id: "finney-rpc",
      kind: "subtensor-rpc",
      endpoint_count: 1,
      eligible_count: 1,
      endpoints: [rpcPoolEndpoint("rpc-a", { status: "degraded", score: 0 })],
    }),
    compose: (baked: Row) =>
      healthServing.overlayRpcPoolEligibility(baked, liveRpcPool()),
    provesLive: (composed: Row) =>
      (composed.endpoints as Row[])[0]?.health_source,
    expected: "live-cron-prober",
  },
  {
    composer: "mergeFreshness",
    routeId: "freshness",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      sources: [
        {
          as_of: BUILT_AT,
          id: "surface-health",
          lane: "health-probe",
          path: "/metagraph/health/summary.json",
          required_for_publish: true,
          stale_after_hours: 24,
          stale_behavior: "block",
          status: "current",
          timestamp: BUILT_AT,
          timestamp_field: "generated_at",
        },
      ],
      summary: {
        adapter_count: 0,
        adapter_snapshot_as_of: null,
        blocking_source_count: 1,
        candidate_discovery_as_of: null,
        health_surface_count: 1,
        health_probe_as_of: BUILT_AT,
        missing_blocking_source_count: 0,
        native_snapshot_captured_at: BUILT_AT,
        native_data_as_of: BUILT_AT,
        openapi_surface_count: 0,
        publish_ready_without_age_check: true,
        schema_snapshot_as_of: null,
        stale_window_warnings: [],
        verification_as_of: null,
        verification_generated_at: null,
        warning_source_count: 0,
      },
    }),
    compose: (baked: Row) =>
      healthServing.mergeFreshness(
        baked,
        { last_run_at: RUN_AT },
        { economicsCapturedAt: RUN_AT, parametersQueriedAt: RUN_AT, now: 0 },
      ),
    // The two lanes that exist only at serve time are APPENDED, so the count
    // moving is what proves the live branch ran.
    provesLive: (composed: Row) => (composed.sources as Row[]).length,
    expected: 3,
  },
  {
    composer: "overlayOverviewHealth",
    routeId: "subnet-overview",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      netuid: 1,
      // Nullable, and the overlay never reads it -- a full profile here would
      // be 40 fields of fixture with nothing to say about the composition.
      profile: null,
      health: null,
      counts: { surfaces: 1, endpoints: 1, candidates: 0 },
    }),
    compose: (baked: Row) =>
      healthServing.overlayOverviewHealth(baked, liveSnapshot(), 1),
    provesLive: (composed: Row) => (composed.health as Row)?.observed_by,
    expected: "live-cron-prober",
  },
  {
    composer: "overlayCatalogDetail",
    routeId: "agent-catalog-subnet",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      netuid: 1,
      service_count: 1,
      services: [
        {
          surface_id: "sn1-api",
          kind: "subnet-api",
          base_url: "https://sn1.example/api",
        },
      ],
    }),
    compose: (baked: Row) =>
      healthServing.overlayCatalogDetail(baked, liveSnapshot(), 1),
    provesLive: (composed: Row) =>
      ((composed.services as Row[])[0]?.health as Row)?.observed_by,
    expected: "live-cron-prober",
  },
  {
    composer: "overlayCatalogIndex",
    routeId: "agent-catalog",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      subnet_count: 1,
      subnets: [{ netuid: 1, service_count: 1 }],
    }),
    compose: (baked: Row) =>
      healthServing.overlayCatalogIndex(baked, liveSnapshot()),
    provesLive: (composed: Row) => (composed.subnets as Row[])[0]?.health,
    expected: "ok",
  },
  {
    composer: "overlayArtifactEndpoints",
    routeId: "endpoints",
    baked: () => ({
      generated_at: BUILT_AT,
      schema_version: 1,
      source: "endpoint-resource-probes",
      summary: {
        endpoint_count: 1,
        monitored_count: 1,
        pool_eligible_count: 0,
      },
      endpoints: [endpointResource()],
    }),
    compose: (baked: Row) =>
      healthServing.overlayArtifactEndpoints(baked, liveSnapshot()),
    provesLive: (composed: Row) =>
      (composed.endpoints as Row[])[0]?.health_source,
    expected: "live-cron-prober",
  },
  {
    composer: "overlaySubnetEconomics",
    // Row-level: the whole delta is the `economics` key on a subnet detail.
    component: "SubnetEconomics",
    baked: () => economicsRow(),
    compose: (baked: Row) =>
      (
        healthServing.overlaySubnetEconomics(
          { netuid: 1 },
          economicsBlob({ subnets: [baked] }),
          1,
        ) as Row
      ).economics,
    provesLive: (composed: Row) => typeof composed.spot_price_tao,
    expected: "number",
  },
  {
    composer: "withSpotPrice",
    component: "SubnetEconomics",
    baked: () => economicsRow(),
    compose: (baked: SubnetEconomics) => healthServing.withSpotPrice(baked),
    provesLive: (composed: Row) => typeof composed.spot_price_tao,
    expected: "number",
  },
  {
    composer: "withSpotPricedEconomics",
    routeId: "economics",
    baked: () => economicsBlob(),
    compose: (baked: Row) => healthServing.withSpotPricedEconomics(baked),
    provesLive: (composed: Row) =>
      typeof (composed.subnets as Row[])[0]?.spot_price_tao,
    expected: "number",
  },
  {
    composer: "withAlphaUsd",
    component: "SubnetEconomics",
    baked: () => economicsRow(),
    compose: (baked: Row) =>
      alphaUsdOverlay.withAlphaUsd(baked, taoUsdReading(), Date.parse(RUN_AT)),
    // The field whose absence from SubnetEconomicsSchema 500'd /api/v1/economics
    // for hours (#10935).
    provesLive: (composed: Row) => typeof composed.alpha_price_usd,
    expected: "number",
  },
  {
    composer: "withAlphaUsdEconomics",
    routeId: "economics",
    baked: () => economicsBlob(),
    compose: (baked: Row) =>
      alphaUsdOverlay.withAlphaUsdEconomics(
        baked,
        taoUsdReading(),
        Date.parse(RUN_AT),
      ),
    provesLive: (composed: Row) =>
      typeof (composed.subnets as Row[])[0]?.alpha_market_cap_usd,
    expected: "number",
  },
  {
    composer: "withAlphaVolumeUsd",
    routeId: "subnet-alpha-volume",
    baked: () => volumeRow(),
    compose: (baked: Row) =>
      alphaUsdOverlay.withAlphaVolumeUsd(
        baked,
        taoUsdReading(),
        Date.parse(RUN_AT),
      ),
    provesLive: (composed: Row) => typeof composed.total_volume_usd,
    expected: "number",
  },
  {
    composer: "withChainAlphaVolumeUsd",
    routeId: "chain-alpha-volume",
    baked: () => ({
      schema_version: 1,
      window: "24h",
      observed_at: RUN_AT,
      subnet_count: 1,
      network: {
        buy_volume_alpha: 10,
        sell_volume_alpha: 8,
        total_volume_alpha: 18,
        buy_volume_tao: 4,
        sell_volume_tao: 3,
        total_volume_tao: 7,
        buy_count: 5,
        sell_count: 4,
        net_volume_alpha: 2,
        sentiment_ratio: 0.55,
        sentiment: "bullish",
      },
      volume_distribution: null,
      subnets: [volumeRow()],
    }),
    compose: (baked: Row) =>
      alphaUsdOverlay.withChainAlphaVolumeUsd(
        baked,
        taoUsdReading(),
        Date.parse(RUN_AT),
      ),
    provesLive: (composed: Row) =>
      typeof (composed.network as Row)?.total_volume_usd,
    expected: "number",
  },
];

// ── The sweep ──────────────────────────────────────────────────────────────

describe("every serve-time overlay produces what its route publishes", () => {
  for (const entry of SWEEP) {
    const componentId =
      entry.component ?? componentForRoute(entry.routeId as string);

    describe(`${entry.composer} -> ${componentId}`, () => {
      test("the baked artifact parses before the overlay touches it", () => {
        // Separated from the composed parse deliberately: a stale fixture and
        // a drifted overlay fail the same assertion otherwise, and only one of
        // them is a production bug.
        const parsed = schemaFor(componentId).safeParse(entry.baked());
        assert.ok(
          parsed.success,
          `the FIXTURE is invalid, not the overlay -- ${componentId} rejects ` +
            "it before any overlay runs: " +
            (parsed.success ? "" : JSON.stringify(parsed.error.issues)),
        );
      });

      test("the overlaid artifact parses against the published component", () => {
        const composed = entry.compose(entry.baked() as never);
        assert.notEqual(
          composed,
          null,
          `${entry.composer} returned null -- it never reached its live ` +
            "branch, so this entry would prove nothing",
        );
        const parsed = schemaFor(componentId).safeParse(composed);
        assert.ok(
          parsed.success,
          `${entry.composer} serves fields ${componentId} does not declare. ` +
            "Declare them on the schema (the overlay is the producer of " +
            "record), or stop writing them: " +
            (parsed.success ? "" : JSON.stringify(parsed.error.issues)),
        );
      });

      test("the overlay's live branch actually ran", () => {
        const composed = entry.compose(entry.baked() as never) as Row;
        assert.deepEqual(
          entry.provesLive(composed as never),
          entry.expected,
          `${entry.composer} did not write the value this entry watches, so ` +
            "the parse above ran on the baked artifact and checked nothing " +
            "about the composition",
        );
      });
    });
  }
});

// ── Coverage: a new overlay is swept the day it is added ───────────────────

describe("the sweep covers every overlay, not the ones remembered", () => {
  // #7860's five-route hand list was stale the day it landed and 156 routes
  // served unchecked behind it. A list of overlays would rot the same way, so
  // the inventory is DISCOVERED from the modules' exports and the sweep must
  // account for all of it.
  //
  // The prefix is the convention both modules already follow: an exported
  // `overlay*` / `merge*` / `with*` / `build*` takes an artifact and returns a
  // composed one. Formatters, selectors and summarizers do not serve a
  // composed artifact and are out of scope by name -- which is exactly why a
  // new composer cannot be added under one of these prefixes without landing
  // here.
  const COMPOSER_NAME = /^(overlay|merge|with|build)[A-Z]/;

  const discovered = new Set(
    [
      ...Object.entries(healthServing),
      ...Object.entries(alphaUsdOverlay),
    ].flatMap(([name, value]) =>
      typeof value === "function" && COMPOSER_NAME.test(name) ? [name] : [],
    ),
  );
  const swept = new Set(SWEEP.map((entry) => entry.composer));

  test("every discovered composer has a sweep entry", () => {
    const missing = [...discovered].filter((name) => !swept.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      "these serve-time composers run over a published artifact with nothing " +
        "parsing what they produce -- add an entry to SWEEP: " +
        missing.join(", "),
    );
  });

  test("every sweep entry names a composer that still exists", () => {
    // The reverse direction, because a one-way check hides the other: a
    // renamed or deleted composer would leave its entry testing a fixture
    // against itself, and the sweep would keep passing while the real overlay
    // ran unchecked.
    const orphaned = [...swept].filter((name) => !discovered.has(name)).sort();
    assert.deepEqual(
      orphaned,
      [],
      "these sweep entries name composers the modules no longer export: " +
        orphaned.join(", "),
    );
  });

  test("the discovery found composers at all", () => {
    // An empty set makes both checks above pass on nothing. If the export
    // shape or the naming convention ever changes, this is what says so
    // instead of the sweep quietly becoming a no-op.
    assert.ok(
      discovered.size >= 10,
      `discovery found only ${discovered.size} composers -- the naming ` +
        "convention the inventory relies on has changed, and both checks " +
        "above are now passing on an almost-empty set",
    );
  });
});

// ── Vacuity: the parse must be able to fail ────────────────────────────────

describe("the sweep can fail", () => {
  test("an undeclared key is refused by every swept component", () => {
    // Without this, a component resolved to something permissive -- or a
    // `.strict()` that got relaxed back to `.passthrough()` -- would make
    // every assertion above pass regardless of what the overlays write. That
    // is the exact state the four outages were served from.
    for (const entry of SWEEP) {
      const componentId =
        entry.component ?? componentForRoute(entry.routeId as string);
      const drifted = {
        ...(entry.compose(entry.baked() as never) as Row),
        // The shape of the real defect: a serve-time key nothing declares.
        overlay_stamped_field_nothing_declares: RUN_AT,
      };
      const parsed = schemaFor(componentId).safeParse(drifted);
      assert.equal(
        parsed.success,
        false,
        `${componentId} accepted an undeclared key, so the ${entry.composer} ` +
          "entry above cannot detect the drift it exists to detect",
      );
    }
  });
});
