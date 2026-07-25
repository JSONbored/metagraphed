// Equivalence-diff audit for the Zod-generated MCP tool schemas (types-epic
// E, #7863 requirement 3): compares each converted tool's Zod-generated
// input/output JSON Schema against the hand-written literal it replaces,
// after normalizing the specific cosmetic differences z.toJSONSchema()
// introduces (documented inline below, mirroring
// scripts/diff-openapi-zod-components.ts's methodology for types-epic B).
// Anything left after normalization is a real difference and must be
// resolved before merge, not silenced here.
//
// The "old" schemas are hand-transcribed from the literals each batch's
// conversion commit replaced (see that commit's diff for src/mcp-server.ts /
// src/global-operational-health.ts / src/network-economics.ts /
// src/health-history-mcp.ts) -- there is no structured old artifact to read
// (unlike B's hand-edited JSON Schema files), since the originals were
// inline JS object literals inside .ts source, not their own JSON files.
// Kept here as the audit's fixed baseline; add a new OLD_SCHEMAS entry
// (never edit an existing one) for each future batch under this issue.
// Batch 1 (pilot, #7863, PR #8087): search_subnets, list_subnets,
// get_subnet, get_network_health, get_subnet_stake_quote, get_economics.
// Batch 2 (#8065): find_subnets_by_capability, get_subnet_detail,
// get_subnet_snapshot, get_subnet_health(+trends/percentiles/incidents),
// get_health_trends, get_subnet_economics, get_stake_action_preview,
// get_subnet_trajectory, get_subnet_concentration, get_subnet_performance,
// get_subnet_idle_stake, get_subnet_movers, get_subnet_uptime,
// get_health_history.
import { z } from "zod";
import {
  SearchSubnetsInputSchema,
  SearchSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/search-subnets.ts";
import {
  ListSubnetsInputSchema,
  ListSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/list-subnets.ts";
import {
  GetSubnetInputSchema,
  GetSubnetOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet.ts";
import {
  GetNetworkHealthInputSchema,
  GetNetworkHealthOutputSchema,
} from "../schemas-src/mcp-tools/get-network-health.ts";
import {
  GetSubnetStakeQuoteInputSchema,
  GetSubnetStakeQuoteOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-stake-quote.ts";
import {
  GetEconomicsInputSchema,
  GetEconomicsOutputSchema,
} from "../schemas-src/mcp-tools/get-economics.ts";
import {
  FindSubnetsByCapabilityInputSchema,
  FindSubnetsByCapabilityOutputSchema,
} from "../schemas-src/mcp-tools/find-subnets-by-capability.ts";
import {
  GetSubnetDetailInputSchema,
  GetSubnetDetailOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-detail.ts";
import {
  GetSubnetSnapshotInputSchema,
  GetSubnetSnapshotOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-snapshot.ts";
import {
  GetSubnetHealthInputSchema,
  GetSubnetHealthOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health.ts";
import {
  GetSubnetHealthTrendsInputSchema,
  GetSubnetHealthTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-trends.ts";
import {
  GetHealthTrendsInputSchema,
  GetHealthTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-health-trends.ts";
import {
  GetSubnetHealthPercentilesInputSchema,
  GetSubnetHealthPercentilesOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-percentiles.ts";
import {
  GetSubnetHealthIncidentsInputSchema,
  GetSubnetHealthIncidentsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-health-incidents.ts";
import {
  GetSubnetEconomicsInputSchema,
  GetSubnetEconomicsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-economics.ts";
import {
  GetStakeActionPreviewInputSchema,
  GetStakeActionPreviewOutputSchema,
} from "../schemas-src/mcp-tools/get-stake-action-preview.ts";
import {
  GetSubnetTrajectoryInputSchema,
  GetSubnetTrajectoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-trajectory.ts";
import {
  GetSubnetConcentrationInputSchema,
  GetSubnetConcentrationOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-concentration.ts";
import {
  GetSubnetPerformanceInputSchema,
  GetSubnetPerformanceOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-performance.ts";
import {
  GetSubnetIdleStakeInputSchema,
  GetSubnetIdleStakeOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-idle-stake.ts";
import {
  GetSubnetMoversInputSchema,
  GetSubnetMoversOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-movers.ts";
import {
  GetSubnetUptimeInputSchema,
  GetSubnetUptimeOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-uptime.ts";
import {
  GetHealthHistoryInputSchema,
  GetHealthHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-health-history.ts";
import {
  GetBlocksSummaryInputSchema,
  GetBlocksSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-blocks-summary.ts";
import {
  GetSubnetConcentrationHistoryInputSchema,
  GetSubnetConcentrationHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-concentration-history.ts";
import {
  GetSubnetTurnoverInputSchema,
  GetSubnetTurnoverOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-turnover.ts";
import {
  GetSubnetYieldInputSchema,
  GetSubnetYieldOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-yield.ts";
import {
  GetSubnetYieldHistoryInputSchema,
  GetSubnetYieldHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-yield-history.ts";
import {
  GetSubnetStakeFlowInputSchema,
  GetSubnetStakeFlowOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-stake-flow.ts";
import {
  GetSubnetEventSummaryInputSchema,
  GetSubnetEventSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-event-summary.ts";
import {
  GetSubnetWeightsInputSchema,
  GetSubnetWeightsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-weights.ts";
import {
  GetSubnetWeightSettersInputSchema,
  GetSubnetWeightSettersOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-weight-setters.ts";
import {
  GetSubnetRegistrationsInputSchema as GetSubnetRegistrationsMcpInputSchema,
  GetSubnetRegistrationsOutputSchema as GetSubnetRegistrationsMcpOutputSchema,
  GetSubnetStakeMovesInputSchema,
  GetSubnetStakeMovesOutputSchema,
  GetSubnetStakeTransfersInputSchema,
  GetSubnetStakeTransfersOutputSchema,
  GetSubnetAxonRemovalsInputSchema as GetSubnetAxonRemovalsMcpInputSchema,
  GetSubnetAxonRemovalsOutputSchema as GetSubnetAxonRemovalsMcpOutputSchema,
  GetSubnetServingInputSchema as GetSubnetServingMcpInputSchema,
  GetSubnetServingOutputSchema as GetSubnetServingMcpOutputSchema,
  GetSubnetPrometheusInputSchema,
  GetSubnetPrometheusOutputSchema,
  GetSubnetDeregistrationsInputSchema as GetSubnetDeregistrationsMcpInputSchema,
  GetSubnetDeregistrationsOutputSchema as GetSubnetDeregistrationsMcpOutputSchema,
} from "../schemas-src/mcp-tools/subnet-activity.ts";
import {
  GetSubnetPerformanceHistoryInputSchema,
  GetSubnetPerformanceHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-performance-history.ts";
import {
  GetEconomicsTrendsInputSchema,
  GetEconomicsTrendsOutputSchema,
} from "../schemas-src/mcp-tools/get-economics-trends.ts";
import {
  GetRegistryLeaderboardsInputSchema,
  GetRegistryLeaderboardsOutputSchema,
} from "../schemas-src/mcp-tools/get-registry-leaderboards.ts";
import {
  GetDomainSummaryInputSchema,
  GetDomainSummaryOutputSchema,
} from "../schemas-src/mcp-tools/get-domain-summary.ts";
import {
  ListProfilesInputSchema,
  ListProfilesOutputSchema,
  GetSubnetProfileInputSchema,
  GetSubnetProfileOutputSchema,
} from "../schemas-src/mcp-tools/profiles.ts";
import {
  CompareSubnetsInputSchema,
  CompareSubnetsOutputSchema,
} from "../schemas-src/mcp-tools/compare-subnets.ts";
import {
  GetSubnetMetagraphInputSchema,
  GetSubnetMetagraphOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-metagraph.ts";
import {
  GetSubnetHistoryInputSchema,
  GetSubnetHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-history.ts";
import {
  GetSubnetIdentityHistoryInputSchema,
  GetSubnetIdentityHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-identity-history.ts";
import {
  GetSubnetEventsInputSchema,
  GetSubnetEventsOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-events.ts";
import {
  GetSubnetHyperparamsInputSchema,
  GetSubnetHyperparamsOutputSchema,
  GetSubnetHyperparamsHistoryInputSchema,
  GetSubnetHyperparamsHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-hyperparams.ts";
import {
  GetSubnetVolumeInputSchema,
  GetSubnetVolumeOutputSchema,
  GetSubnetOhlcInputSchema,
  GetSubnetOhlcOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-volume-ohlc.ts";
import {
  GetSubnetOwnershipHistoryInputSchema,
  GetSubnetOwnershipHistoryOutputSchema,
  GetSubnetConvictionInputSchema,
  GetSubnetConvictionOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-ownership-conviction.ts";
import {
  GetSubnetRecycledInputSchema,
  GetSubnetRecycledOutputSchema,
  GetSubnetBurnInputSchema,
  GetSubnetBurnOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-recycled-burn.ts";
import {
  GetSubnetLeaseInputSchema,
  GetSubnetLeaseOutputSchema,
  GetSubnetLeaseHistoryInputSchema,
  GetSubnetLeaseHistoryOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-lease.ts";

type Row = Record<string, unknown>;

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };
const ANY = {};
const objectItems = (properties: Row = {}) => ({
  type: "array",
  items: { type: "object", additionalProperties: true, properties },
});

// Resolved literal values for the enums the old schemas referenced
// symbolically (QUERY_ENUMS.*, API_QUERY_COLLECTIONS.economics.sort_fields)
// -- see src/contracts.ts, cross-checked against the actual runtime arrays
// at the time of writing.
const COVERAGE_LEVEL = ["native-only", "manifested", "probed"];
const CURATION_LEVEL = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
];
const LIST_SUBNETS_SORT_FIELDS = [
  "netuid",
  "integration_readiness",
  "surface_count",
  "name",
];
const LIST_SUBNETS_ORDERS = ["asc", "desc"];
const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"];
const ECONOMICS_SORT_FIELDS = [
  "alpha_fdv_tao",
  "alpha_market_cap_tao",
  "alpha_price_change_1d",
  "alpha_price_change_1h",
  "alpha_price_change_1m",
  "alpha_price_change_7d",
  "alpha_price_tao",
  "block",
  "emission_share",
  "max_stake_tao",
  "max_uids",
  "max_validators",
  "miner_count",
  "miner_readiness",
  "name",
  "netuid",
  "open_slots",
  "registration_cost_tao",
  "subnet_volume_tao",
  "total_stake_tao",
  "validator_count",
];
// Batch-2 (#8065) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/movers.ts's MOVERS_WINDOWS/MOVERS_SORTS,
// src/contracts.ts's QUERY_ENUMS/API_QUERY_COLLECTIONS), cross-checked
// against the actual runtime source at the time of writing.
const HEALTH_WINDOWS = ["7d", "30d"];
const UPTIME_WINDOWS = ["90d", "1y"];
const MOVERS_WINDOW_KEYS = ["7d", "30d", "90d"];
const MOVERS_SORTS = ["stake", "emission", "validators", "neurons"];
const MOVERS_LIMIT_MAX = 100;
const SURFACE_KIND = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
];
const HEALTH_STATUS = ["ok", "degraded", "failed", "unknown"];
const HEALTH_CLASSIFICATION = [
  "auth-required",
  "content-mismatch",
  "dead",
  "live",
  "rate-limited",
  "redirected",
  "timeout",
  "transient",
  "unsupported",
  "unsafe",
  "wrong-chain",
];
const HEALTH_SURFACE_SORT_FIELDS = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
];

// Batch 3 (#8066) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (each tool's own src/subnet-*.ts WINDOWS
// constant, src/stake-flow.ts's STAKE_FLOW_WINDOWS/DIRECTIONS,
// src/neuron-history.ts's HISTORY_WINDOWS), cross-checked against the
// actual runtime source at the time of writing.
const ACTIVITY_WINDOWS = ["7d", "30d"];
const HISTORY_WINDOWS_3 = ["7d", "30d", "90d"];
const HISTORY_WINDOWS_5 = ["7d", "30d", "90d", "1y", "all"];
const STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"];
const STAKE_FLOW_DIRECTIONS = ["all", "in", "out"];
// Batch 4 (#8067) resolved enum values, same treatment as above -- symbolic
// in the hand-written originals (src/health-serving.ts's LEADERBOARD_BOARDS,
// src/domain-tags.ts's DOMAIN_TAGS, src/contracts.ts's QUERY_ENUMS + the
// "profiles" query collection's sort_fields, src/subnet-ohlc.ts's
// OHLC_INTERVALS, src/neuron-history.ts's HISTORY_WINDOWS), cross-checked
// against the actual runtime source at the time of writing.
const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
];
const DOMAIN_TAGS = [
  "agents",
  "compute",
  "data",
  "finance",
  "inference",
  "media",
  "prediction",
  "privacy",
  "robotics",
  "science",
  "search",
  "security",
  "storage",
  "training",
];
const PROFILE_SUBNET_TYPE = ["root", "application"];
const PROFILE_CURATION_LEVEL = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
];
const PROFILE_LEVEL = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
];
const PROFILES_SORT_FIELDS_4 = [
  "candidate_count",
  "completeness_score",
  "curation_level",
  "interface_count",
  "missing_critical_count",
  "name",
  "netuid",
  "operational_interface_count",
  "profile_level",
  "review_state",
];
const COMPARE_DIMENSIONS = ["structure", "economics", "health"];
const HISTORY_WINDOWS_4 = ["7d", "30d", "90d", "1y", "all"];
const OHLC_INTERVALS_4 = ["1h", "1d"];

const OLD_SCHEMAS: Record<string, { input: Row; output: Row }> = {
  search_subnets: {
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "query",
        "total",
        "count",
        "cursor",
        "limit",
        "next_cursor",
        "results",
      ],
      properties: {
        query: { type: "string" },
        total: { type: "integer" },
        count: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        next_cursor: { type: ["integer", "null"] },
        results: objectItems({
          netuid: { type: "integer" },
          slug: { type: "string" },
          title: NULLABLE_STRING,
          description: NULLABLE_STRING,
          url: NULLABLE_STRING,
        }),
      },
    },
  },
  list_subnets: {
    input: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        status: { type: "string" },
        subnet_type: { type: "string" },
        domain: { type: "string" },
        not_status: { type: "string" },
        not_subnet_type: { type: "string" },
        not_domain: { type: "string" },
        coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        not_coverage_level: { type: "string", enum: COVERAGE_LEVEL },
        curation_level: { type: "string", enum: CURATION_LEVEL },
        not_curation_level: { type: "string", enum: CURATION_LEVEL },
        min_readiness: { type: "integer", minimum: 0, maximum: 100 },
        max_readiness: { type: "integer", minimum: 0, maximum: 100 },
        min_surface_count: { type: "integer", minimum: 0 },
        max_surface_count: { type: "integer", minimum: 0 },
        min_block: { type: "number" },
        max_block: { type: "number" },
        min_candidate_count: { type: "integer", minimum: 0 },
        max_candidate_count: { type: "integer", minimum: 0 },
        min_mechanism_count: { type: "integer", minimum: 0 },
        max_mechanism_count: { type: "integer", minimum: 0 },
        min_participant_count: { type: "integer", minimum: 0 },
        max_participant_count: { type: "integer", minimum: 0 },
        min_probed_surface_count: { type: "integer", minimum: 0 },
        max_probed_surface_count: { type: "integer", minimum: 0 },
        min_tempo: { type: "integer", minimum: 0 },
        max_tempo: { type: "integer", minimum: 0 },
        min_netuid: { type: "integer", minimum: 0 },
        max_netuid: { type: "integer", minimum: 0 },
        sort: { type: "string", enum: LIST_SUBNETS_SORT_FIELDS },
        order: { type: "string", enum: LIST_SUBNETS_ORDERS },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "total",
        "returned",
        "cursor",
        "limit",
        "next_cursor",
        "subnets",
      ],
      properties: {
        total: { type: "integer" },
        returned: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
        next_cursor: { type: ["integer", "null"] },
        subnets: objectItems({
          netuid: { type: "integer" },
          slug: NULLABLE_STRING,
          title: NULLABLE_STRING,
          subnet_type: NULLABLE_STRING,
          status: NULLABLE_STRING,
          integration_readiness: { type: ["number", "null"] },
          surface_count: { type: ["integer", "null"] },
        }),
      },
    },
  },
  get_subnet: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid"],
      properties: {
        netuid: { type: "integer" },
        name: NULLABLE_STRING,
        slug: NULLABLE_STRING,
        status: NULLABLE_STRING,
        health: { type: ["object", "null"] },
        profile: { type: ["object", "null"] },
        counts: { type: "object" },
        curation: { type: ["object", "null"] },
        gaps: { type: ["object", "null"] },
        gap_priorities: { type: "array" },
        operational_observed_at: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
      },
    },
  },
  get_network_health: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "scope", "global", "subnets"],
      properties: {
        schema_version: { type: "integer" },
        contract_version: { type: ["integer", "string", "null"] },
        generated_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        health_source: NULLABLE_STRING,
        scope: { type: "string" },
        operational_observed_at: NULLABLE_STRING,
        global: { type: "object" },
        subnets: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_stake_quote: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        amount: { type: "number", exclusiveMinimum: 0 },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
      },
      required: ["netuid", "amount"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "netuid",
        "direction",
        "amount",
        "expected_out",
        "expected_out_unit",
        "spot_price_tao",
        "effective_price_tao",
        "price_impact_pct",
        "tao_in_pool_tao",
        "alpha_in_pool",
        "is_root",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
        // Bucket-(a): the original left `amount` an unbounded
        // {type:"number"}; the Zod schema reuses
        // SubnetStakeQuoteArtifactSchema, which carries the SAME .gt(0) the
        // input side already enforces, and the value is always an echo of
        // an already-validated input -- a deliberate, verified tightening
        // (see get-subnet-stake-quote.ts's header), not an oversight. NOT
        // normalized away: `amount` here intentionally omits the bound so
        // this diff shows it, and the PR body calls it out explicitly.
        amount: { type: "number" },
        expected_out: { type: "number" },
        expected_out_unit: { type: "string", enum: ["alpha", "tao"] },
        spot_price_tao: { type: "number" },
        effective_price_tao: { type: "number" },
        price_impact_pct: { type: "number" },
        tao_in_pool_tao: { type: ["number", "null"] },
        alpha_in_pool: { type: ["number", "null"] },
        is_root: { type: "boolean" },
      },
    },
  },
  get_economics: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        registration_allowed: { type: "string", enum: ["true", "false"] },
        q: { type: "string" },
        sort: { type: "string", enum: ECONOMICS_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["source", "subnets"],
      properties: {
        source: NULLABLE_STRING,
        captured_at: NULLABLE_STRING,
        network: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        subnets: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  find_subnets_by_capability: {
    input: {
      type: "object",
      properties: {
        capability: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["capability"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "capability",
        "total",
        "count",
        "cursor",
        "limit",
        "next_cursor",
        "results",
      ],
      properties: {
        capability: { type: "string" },
        total: { type: "integer" },
        count: { type: "integer" },
        cursor: { type: "integer" },
        limit: { type: "integer" },
        next_cursor: { type: ["integer", "null"] },
        results: objectItems({
          netuid: { type: "integer" },
          slug: { type: "string" },
          name: NULLABLE_STRING,
          categories: { type: "array" },
          service_kinds: { type: "array" },
          callable_count: { type: "integer" },
          integration_readiness: ANY,
        }),
      },
    },
  },
  get_subnet_detail: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["subnet"],
      properties: {
        schema_version: { type: "integer" },
        generated_at: NULLABLE_STRING,
        subnet: { type: "object" },
        candidate_surfaces: { type: "array" },
        candidates: { type: "array" },
        endpoints: { type: "array" },
        gaps: ANY,
        surfaces: { type: "array" },
        verified_surfaces: { type: "array" },
        economics: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_snapshot: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        top_validators_limit: { type: "integer", minimum: 1 },
        recent_events_limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "hyperparameters",
        "concentration",
        "performance",
        "top_validators",
        "recent_events",
      ],
      properties: {
        netuid: { type: "integer" },
        hyperparameters: { type: "object" },
        concentration: { type: "object" },
        performance: { type: "object" },
        top_validators: { type: "object" },
        recent_events: { type: "object" },
      },
    },
  },
  get_subnet_health: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "summary", "surfaces"],
      properties: {
        netuid: { type: "integer" },
        summary: { type: "object" },
        operational_observed_at: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: { type: "string" },
          netuid: { type: "integer" },
          kind: NULLABLE_STRING,
          status: { type: "string" },
          latency_ms: NULLABLE_INT,
          last_checked: NULLABLE_STRING,
          last_ok: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_health_trends: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "windows"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        windows: { type: "object" },
      },
    },
  },
  get_health_trends: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["windows"],
      properties: {
        schema_version: { type: "integer" },
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        windows: { type: "object" },
      },
    },
  },
  get_subnet_health_percentiles: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HEALTH_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: NULLABLE_STRING,
          samples: { type: "integer" },
          latency_ms: {
            type: "object",
            additionalProperties: true,
            properties: {
              p50: NULLABLE_INT,
              p95: NULLABLE_INT,
              p99: NULLABLE_INT,
              avg: NULLABLE_INT,
              min: NULLABLE_INT,
              max: NULLABLE_INT,
            },
          },
        }),
      },
    },
  },
  get_subnet_health_incidents: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HEALTH_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        source: NULLABLE_STRING,
        surfaces: objectItems({
          surface_id: NULLABLE_STRING,
          samples: { type: "integer" },
          uptime_ratio: { type: ["number", "null"] },
          incident_count: { type: "integer" },
          downtime_ms: { type: "integer" },
          incidents: objectItems({
            started_at: NULLABLE_INT,
            ended_at: NULLABLE_INT,
            duration_ms: NULLABLE_INT,
            failed_samples: { type: "integer" },
          }),
        }),
      },
    },
  },
  get_subnet_economics: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "economics"],
      properties: {
        netuid: { type: "integer" },
        source: NULLABLE_STRING,
        captured_at: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        economics: { type: ["object", "null"] },
      },
    },
  },
  get_stake_action_preview: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        amount: { type: "number", exclusiveMinimum: 0 },
        direction: { type: "string", enum: STAKE_QUOTE_DIRECTIONS },
      },
      required: ["netuid", "amount"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        netuid: { type: "integer" },
        direction: { type: "string" },
        amount: { type: "number" },
        summary: { type: "string" },
        estimated_out: {
          type: "object",
          properties: {
            amount: { type: "number" },
            unit: { type: "string" },
          },
          required: ["amount", "unit"],
          additionalProperties: false,
        },
        spot_price_tao: { type: "number" },
        effective_price_tao: { type: "number" },
        price_impact_pct: { type: "number" },
        warnings: { type: "array", items: { type: "string" } },
        ok: { type: "boolean" },
        disclaimer: { type: "string" },
      },
      required: [
        "netuid",
        "direction",
        "amount",
        "summary",
        "warnings",
        "ok",
        "disclaimer",
      ],
      additionalProperties: true,
    },
  },
  get_subnet_trajectory: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
        deltas: { type: "object" },
      },
    },
  },
  get_subnet_concentration: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        entity_count: { type: "integer" },
        uids_per_entity: { type: ["number", "null"] },
        captured_at: NULLABLE_STRING,
        stake: { type: ["object", "null"] },
        emission: { type: ["object", "null"] },
        entity_stake: { type: ["object", "null"] },
        entity_emission: { type: ["object", "null"] },
        validator_stake: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_performance: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        active_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        incentive: { type: ["object", "null"] },
        dividends: { type: ["object", "null"] },
        trust: { type: ["object", "null"] },
        consensus: { type: ["object", "null"] },
        validator_trust: { type: ["object", "null"] },
      },
    },
  },
  get_subnet_idle_stake: {
    input: {
      type: "object",
      properties: { netuid: { type: "integer", minimum: 0 } },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "neuron_count",
        "idle_neuron_count",
        "idle_stake_tao",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        neuron_count: { type: "integer" },
        idle_neuron_count: { type: "integer" },
        idle_stake_tao: { type: "number" },
      },
    },
  },
  get_subnet_movers: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: MOVERS_WINDOW_KEYS },
        sort: { type: "string", enum: MOVERS_SORTS },
        limit: { type: "integer", minimum: 1, maximum: MOVERS_LIMIT_MAX },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "sort", "subnet_count", "movers"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        start_date: NULLABLE_STRING,
        end_date: NULLABLE_STRING,
        sort: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        movers: objectItems({
          netuid: { type: "integer" },
          stake_start_tao: ANY,
          stake_end_tao: ANY,
          stake_delta_tao: ANY,
          stake_pct_change: { type: ["number", "null"] },
          emission_start_tao: ANY,
          emission_end_tao: ANY,
          emission_delta_tao: ANY,
          emission_pct_change: { type: ["number", "null"] },
          validators_start: { type: "integer" },
          validators_end: { type: "integer" },
          validators_delta: { type: "integer" },
          neurons_start: { type: "integer" },
          neurons_end: { type: "integer" },
          neurons_delta: { type: "integer" },
        }),
      },
    },
  },
  get_subnet_uptime: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: UPTIME_WINDOWS },
        min_samples: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "surfaces"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        surfaces: { type: "array", items: { type: "object" } },
        reliability: { type: ["object", "null"] },
      },
    },
  },
  get_health_history: {
    input: {
      type: "object",
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: SURFACE_KIND },
        provider: { type: "string" },
        status: { type: "string", enum: HEALTH_STATUS },
        classification: { type: "string", enum: HEALTH_CLASSIFICATION },
        sort: { type: "string", enum: HEALTH_SURFACE_SORT_FIELDS },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      required: ["date"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["date", "surfaces"],
      properties: {
        date: NULLABLE_STRING,
        summary: { type: ["object", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_blocks_summary: {
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["block_count"],
      properties: {
        schema_version: { type: "integer" },
        block_count: { type: "integer" },
        first_block: { type: ["integer", "null"] },
        last_block: { type: ["integer", "null"] },
        first_observed_at: NULLABLE_STRING,
        last_observed_at: NULLABLE_STRING,
        block_time: { type: ["object", "null"] },
        throughput: { type: ["object", "null"] },
        distinct_authors: { type: "integer" },
        author_concentration: { type: ["object", "null"] },
        distinct_spec_versions: { type: "integer" },
        latest_spec_version: { type: ["integer", "null"] },
      },
    },
  },
  get_subnet_concentration_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: objectItems({
          snapshot_date: NULLABLE_STRING,
          neuron_count: NULLABLE_INT,
          stake_gini: ANY,
          stake_nakamoto_coefficient: ANY,
          stake_top_10pct_share: ANY,
          emission_gini: ANY,
          emission_nakamoto_coefficient: ANY,
          emission_top_10pct_share: ANY,
        }),
      },
    },
  },
  get_subnet_turnover: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
        changes: { type: "boolean" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "comparable",
        "validators_start",
        "validators_end",
        "validators_entered",
        "validators_exited",
        "neurons_start",
        "neurons_end",
        "uids_deregistered",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        start_date: NULLABLE_STRING,
        end_date: NULLABLE_STRING,
        comparable: { type: "boolean" },
        validators_start: { type: "integer" },
        validators_end: { type: "integer" },
        validators_entered: { type: "integer" },
        validators_exited: { type: "integer" },
        validator_retention: { type: ["number", "null"] },
        neurons_start: { type: "integer" },
        neurons_end: { type: "integer" },
        uids_deregistered: { type: "integer" },
        neuron_retention: { type: ["number", "null"] },
        stability_score: { type: ["integer", "null"] },
        changes: {
          type: "object",
          properties: {
            validators_entered_count: { type: "integer" },
            validators_exited_count: { type: "integer" },
            uid_reassignment_count: { type: "integer" },
            validators_entered: { type: "array", items: { type: "object" } },
            validators_exited: { type: "array", items: { type: "object" } },
            uid_reassignments: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
  get_subnet_yield: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count", "neurons"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        neuron_count: { type: "integer" },
        validator_count: { type: "integer" },
        miner_count: { type: "integer" },
        total_stake_tao: { type: ["number", "null"] },
        total_emission_tao: { type: ["number", "null"] },
        subnet_yield: { type: ["number", "null"] },
        mean_yield: { type: ["number", "null"] },
        median_yield: { type: ["number", "null"] },
        p25_yield: { type: ["number", "null"] },
        p75_yield: { type: ["number", "null"] },
        p90_yield: { type: ["number", "null"] },
        neurons: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_yield_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_stake_flow: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: STAKE_FLOW_WINDOWS },
        direction: { type: "string", enum: STAKE_FLOW_DIRECTIONS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "total_staked_tao",
        "total_unstaked_tao",
        "net_flow_tao",
        "stake_events",
        "unstake_events",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        total_staked_tao: ANY,
        total_unstaked_tao: ANY,
        net_flow_tao: ANY,
        stake_events: { type: "integer" },
        unstake_events: { type: "integer" },
      },
    },
  },
  get_subnet_event_summary: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "total_events",
        "kind_count",
        "recent_event_count",
        "categories",
        "event_kinds",
        "recent_events",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        total_events: { type: "integer" },
        kind_count: { type: "integer" },
        category_count: { type: "integer" },
        recent_event_count: { type: "integer" },
        limit: NULLABLE_INT,
        categories: objectItems({
          category: NULLABLE_STRING,
          event_count: { type: "integer" },
          kind_count: { type: "integer" },
          amount_tao: ANY,
          alpha_amount: ANY,
          first_block: NULLABLE_INT,
          last_block: NULLABLE_INT,
          first_observed_at: NULLABLE_STRING,
          last_observed_at: NULLABLE_STRING,
        }),
        event_kinds: objectItems({
          event_kind: NULLABLE_STRING,
          category: NULLABLE_STRING,
          event_count: { type: "integer" },
          hotkey_count: { type: "integer" },
          coldkey_count: { type: "integer" },
          amount_tao: ANY,
          alpha_amount: ANY,
          first_block: NULLABLE_INT,
          last_block: NULLABLE_INT,
          first_observed_at: NULLABLE_STRING,
          last_observed_at: NULLABLE_STRING,
        }),
        recent_events: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_weights: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_setters",
        "weight_sets",
        "sets_per_setter",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_setters: { type: "integer" },
        weight_sets: { type: "integer" },
        sets_per_setter: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_weight_setters: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_setters",
        "weight_sets",
        "setter_count",
        "setters",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_setters: { type: "integer" },
        weight_sets: { type: "integer" },
        setter_count: { type: "integer" },
        setters: objectItems({
          hotkey: NULLABLE_STRING,
          uid: NULLABLE_INT,
          weight_sets: { type: "integer" },
          share: ANY,
          first_set_at: NULLABLE_STRING,
          last_set_at: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_registrations: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_registrants", "registrations"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_registrants: { type: "integer" },
        registrations: { type: "integer" },
        registrations_per_registrant: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_stake_moves: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_movers", "movements"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_movers: { type: "integer" },
        movements: { type: "integer" },
        movements_per_mover: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_stake_transfers: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "distinct_senders", "transfers"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_senders: { type: "integer" },
        transfers: { type: "integer" },
        transfers_per_sender: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_axon_removals: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_removers",
        "removals",
        "removals_per_remover",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_removers: { type: "integer" },
        removals: { type: "integer" },
        removals_per_remover: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_serving: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_servers",
        "announcements",
        "announcements_per_server",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_servers: { type: "integer" },
        announcements: { type: "integer" },
        announcements_per_server: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_prometheus: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_exporters",
        "announcements",
        "announcements_per_exporter",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_exporters: { type: "integer" },
        announcements: { type: "integer" },
        announcements_per_exporter: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_deregistrations: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: ACTIVITY_WINDOWS },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: [
        "netuid",
        "window",
        "distinct_deregistered_hotkeys",
        "deregistrations",
        "deregistrations_per_hotkey",
      ],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        distinct_deregistered_hotkeys: { type: "integer" },
        deregistrations: { type: "integer" },
        deregistrations_per_hotkey: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_performance_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_3 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_economics_trends: {
    input: {
      type: "object",
      properties: {
        window: { type: "string", enum: HISTORY_WINDOWS_5 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["window", "day_count", "days"],
      properties: {
        schema_version: { type: "integer" },
        window: NULLABLE_STRING,
        day_count: { type: "integer" },
        days: objectItems({
          snapshot_date: NULLABLE_STRING,
          subnet_count: NULLABLE_INT,
          total_stake_tao: { type: ["number", "null"] },
          alpha_price_tao_weighted: { type: ["number", "null"] },
          alpha_price_tao_median: { type: ["number", "null"] },
          validator_count: NULLABLE_INT,
          miner_count: NULLABLE_INT,
          mean_emission_share: { type: ["number", "null"] },
        }),
      },
    },
  },
  get_registry_leaderboards: {
    input: {
      type: "object",
      properties: {
        board: { type: "string", enum: LEADERBOARD_BOARDS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["boards"],
      properties: {
        schema_version: { type: "integer" },
        board: NULLABLE_STRING,
        observed_at: NULLABLE_STRING,
        boards: { type: "object" },
      },
    },
  },
  get_domain_summary: {
    input: {
      type: "object",
      properties: {
        domain: { type: "string", enum: DOMAIN_TAGS },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version"],
      properties: {
        schema_version: { type: "integer" },
        domain: NULLABLE_STRING,
        subnet_count: { type: "integer" },
        netuids: { type: "array", items: { type: "integer" } },
        total_stake_tao: { type: ["number", "null"] },
        total_emission_share: { type: ["number", "null"] },
        emission_concentration: { type: ["object", "null"] },
        domain_count: { type: "integer" },
        domains: { type: "array", items: { type: "object" } },
      },
    },
  },
  list_profiles: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        subnet_type: { type: "string", enum: PROFILE_SUBNET_TYPE },
        curation_level: { type: "string", enum: PROFILE_CURATION_LEVEL },
        review_state: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        profile_level: { type: "string", enum: PROFILE_LEVEL },
        q: { type: "string" },
        sort: { type: "string", enum: PROFILES_SORT_FIELDS_4 },
        order: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["profiles"],
      properties: {
        captured_at: NULLABLE_STRING,
        profiles: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        returned: { type: "integer" },
        limit: { type: "integer" },
        cursor: { type: "integer" },
        next_cursor: NULLABLE_INT,
        sort: NULLABLE_STRING,
        order: NULLABLE_STRING,
      },
    },
  },
  get_subnet_profile: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      properties: {
        schema_version: { type: "integer" },
        contract_version: NULLABLE_STRING,
        generated_at: NULLABLE_STRING,
        subnet: { type: ["object", "null"] },
        profile: { type: ["object", "null"] },
        surfaces: { type: "array", items: { type: "object" } },
        endpoints: { type: "array", items: { type: "object" } },
        gaps: { type: ["object", "null"] },
      },
    },
  },
  compare_subnets: {
    input: {
      type: "object",
      properties: {
        netuids: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 1,
          maxItems: 128,
        },
        dimensions: {
          type: "array",
          items: { type: "string", enum: COMPARE_DIMENSIONS },
        },
      },
      required: ["netuids"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["requested_netuids", "subnets", "dimensions"],
      properties: {
        schema_version: { type: "integer" },
        requested_netuids: { type: "array", items: { type: "integer" } },
        dimensions: { type: "array", items: { type: "string" } },
        subnets: { type: "array", items: { type: "object" } },
        observed_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_metagraph: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        validator_permit: { type: "boolean" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "neuron_count", "neurons"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        neuron_count: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        neurons: { type: "array", items: { type: "object" } },
      },
    },
  },
  get_subnet_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        window: { type: "string", enum: HISTORY_WINDOWS_4 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "point_count", "points"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: NULLABLE_STRING,
        point_count: { type: "integer" },
        points: objectItems({
          snapshot_date: NULLABLE_STRING,
          neuron_count: NULLABLE_INT,
          validator_count: NULLABLE_INT,
          total_stake_tao: ANY,
          total_emission_tao: ANY,
        }),
      },
    },
  },
  get_subnet_identity_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["schema_version", "netuid", "entry_count", "entries"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        entry_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        entries: objectItems({
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
          subnet_name: NULLABLE_STRING,
          symbol: NULLABLE_STRING,
          description: NULLABLE_STRING,
          github_repo: NULLABLE_STRING,
          subnet_url: NULLABLE_STRING,
          discord: NULLABLE_STRING,
          logo_url: NULLABLE_STRING,
          identity_hash: { type: "string" },
        }),
      },
    },
  },
  get_subnet_events: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        kind: { type: "string" },
        block_start: { type: "integer", minimum: 0 },
        block_end: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "event_count", "events"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        event_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        events: objectItems({
          block_number: NULLABLE_INT,
          event_index: NULLABLE_INT,
          event_kind: NULLABLE_STRING,
          hotkey: NULLABLE_STRING,
          coldkey: NULLABLE_STRING,
          netuid: NULLABLE_INT,
          uid: NULLABLE_INT,
          amount_tao: ANY,
          alpha_amount: ANY,
          observed_at: NULLABLE_STRING,
          extrinsic_index: NULLABLE_INT,
        }),
      },
    },
  },
  get_subnet_hyperparams: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        captured_at: NULLABLE_STRING,
        block_number: NULLABLE_INT,
        hyperparameters: {
          type: ["object", "null"],
          additionalProperties: true,
        },
      },
    },
  },
  get_subnet_hyperparams_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0 },
        cursor: { type: "string" },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "entry_count", "entries"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        entry_count: { type: "integer" },
        limit: NULLABLE_INT,
        offset: NULLABLE_INT,
        next_cursor: NULLABLE_STRING,
        entries: objectItems({
          block_number: NULLABLE_INT,
          observed_at: NULLABLE_STRING,
          hyperparameters: {
            type: ["object", "null"],
            additionalProperties: true,
          },
          hyperparams_hash: NULLABLE_STRING,
        }),
      },
    },
  },
  get_subnet_volume: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "window"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        window: { type: "string" },
        buy_volume_alpha: ANY,
        sell_volume_alpha: ANY,
        total_volume_alpha: ANY,
        buy_volume_tao: ANY,
        sell_volume_tao: ANY,
        total_volume_tao: ANY,
        buy_count: { type: "integer" },
        sell_count: { type: "integer" },
        net_volume_alpha: ANY,
        sentiment_ratio: { type: ["number", "null"] },
        sentiment: NULLABLE_STRING,
        vol_mcap_ratio: { type: ["number", "null"] },
      },
    },
  },
  get_subnet_ohlc: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
        interval: { type: "string", enum: OHLC_INTERVALS_4 },
        days: { type: "integer", minimum: 1, maximum: 365 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "interval", "candles", "root_excluded"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        interval: { type: "string" },
        candles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              bucket_start: { type: "integer" },
              bucket_start_iso: { type: "string" },
              open: ANY,
              high: ANY,
              low: ANY,
              close: ANY,
              volume_alpha: ANY,
              volume_tao: ANY,
              event_count: { type: "integer" },
            },
          },
        },
        root_excluded: { type: "boolean" },
      },
    },
  },
  get_subnet_ownership_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "ownership_changes"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        count: { type: "integer" },
        ownership_changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              netuid: { type: ["integer", "null"] },
              old_coldkey: { type: ["string", "null"] },
              new_coldkey: { type: ["string", "null"] },
              block_number: { type: ["integer", "null"] },
              observed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
  get_subnet_conviction: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "leaderboard"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        queried_at_block: { type: ["integer", "null"] },
        unlock_rate: { type: ["integer", "null"] },
        maturity_rate: { type: ["integer", "null"] },
        king: { type: ["string", "null"] },
        count: { type: "integer" },
        leaderboard: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              hotkey: { type: "string" },
              is_owner: { type: "boolean" },
              locked_mass: { type: "number" },
              conviction: { type: "number" },
            },
          },
        },
      },
    },
  },
  get_subnet_recycled: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        recycled_tao: { type: ["number", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_burn: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "queried_at"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        burn_tao: { type: ["number", "null"] },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_lease: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "leased"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        leased: { type: ["boolean", "null"] },
        lease: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            lease_id: { type: "integer" },
            beneficiary: { type: "string" },
            coldkey: { type: "string" },
            hotkey: { type: "string" },
            emissions_share_percent: { type: "integer" },
            end_block: { type: ["integer", "null"] },
            netuid: { type: "integer" },
            cost_tao: { type: "number" },
            accumulated_dividends_alpha: { type: ["number", "null"] },
          },
        },
        queried_at: NULLABLE_STRING,
      },
    },
  },
  get_subnet_lease_history: {
    input: {
      type: "object",
      properties: {
        netuid: { type: "integer", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      additionalProperties: true,
      required: ["netuid", "count", "lease_events"],
      properties: {
        schema_version: { type: "integer" },
        netuid: { type: "integer" },
        count: { type: "integer" },
        lease_events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              event_kind: { type: "string" },
              beneficiary: { type: ["string", "null"] },
              block_number: { type: ["integer", "null"] },
              observed_at: NULLABLE_STRING,
            },
          },
        },
      },
    },
  },
};

const NEW_SCHEMAS: Record<string, { input: z.ZodType; output: z.ZodType }> = {
  search_subnets: {
    input: SearchSubnetsInputSchema,
    output: SearchSubnetsOutputSchema,
  },
  list_subnets: {
    input: ListSubnetsInputSchema,
    output: ListSubnetsOutputSchema,
  },
  get_subnet: { input: GetSubnetInputSchema, output: GetSubnetOutputSchema },
  get_network_health: {
    input: GetNetworkHealthInputSchema,
    output: GetNetworkHealthOutputSchema,
  },
  get_subnet_stake_quote: {
    input: GetSubnetStakeQuoteInputSchema,
    output: GetSubnetStakeQuoteOutputSchema,
  },
  get_economics: {
    input: GetEconomicsInputSchema,
    output: GetEconomicsOutputSchema,
  },
  find_subnets_by_capability: {
    input: FindSubnetsByCapabilityInputSchema,
    output: FindSubnetsByCapabilityOutputSchema,
  },
  get_subnet_detail: {
    input: GetSubnetDetailInputSchema,
    output: GetSubnetDetailOutputSchema,
  },
  get_subnet_snapshot: {
    input: GetSubnetSnapshotInputSchema,
    output: GetSubnetSnapshotOutputSchema,
  },
  get_subnet_health: {
    input: GetSubnetHealthInputSchema,
    output: GetSubnetHealthOutputSchema,
  },
  get_subnet_health_trends: {
    input: GetSubnetHealthTrendsInputSchema,
    output: GetSubnetHealthTrendsOutputSchema,
  },
  get_health_trends: {
    input: GetHealthTrendsInputSchema,
    output: GetHealthTrendsOutputSchema,
  },
  get_subnet_health_percentiles: {
    input: GetSubnetHealthPercentilesInputSchema,
    output: GetSubnetHealthPercentilesOutputSchema,
  },
  get_subnet_health_incidents: {
    input: GetSubnetHealthIncidentsInputSchema,
    output: GetSubnetHealthIncidentsOutputSchema,
  },
  get_subnet_economics: {
    input: GetSubnetEconomicsInputSchema,
    output: GetSubnetEconomicsOutputSchema,
  },
  get_stake_action_preview: {
    input: GetStakeActionPreviewInputSchema,
    output: GetStakeActionPreviewOutputSchema,
  },
  get_subnet_trajectory: {
    input: GetSubnetTrajectoryInputSchema,
    output: GetSubnetTrajectoryOutputSchema,
  },
  get_subnet_concentration: {
    input: GetSubnetConcentrationInputSchema,
    output: GetSubnetConcentrationOutputSchema,
  },
  get_subnet_performance: {
    input: GetSubnetPerformanceInputSchema,
    output: GetSubnetPerformanceOutputSchema,
  },
  get_subnet_idle_stake: {
    input: GetSubnetIdleStakeInputSchema,
    output: GetSubnetIdleStakeOutputSchema,
  },
  get_subnet_movers: {
    input: GetSubnetMoversInputSchema,
    output: GetSubnetMoversOutputSchema,
  },
  get_subnet_uptime: {
    input: GetSubnetUptimeInputSchema,
    output: GetSubnetUptimeOutputSchema,
  },
  get_health_history: {
    input: GetHealthHistoryInputSchema,
    output: GetHealthHistoryOutputSchema,
  },
  get_blocks_summary: {
    input: GetBlocksSummaryInputSchema,
    output: GetBlocksSummaryOutputSchema,
  },
  get_subnet_concentration_history: {
    input: GetSubnetConcentrationHistoryInputSchema,
    output: GetSubnetConcentrationHistoryOutputSchema,
  },
  get_subnet_turnover: {
    input: GetSubnetTurnoverInputSchema,
    output: GetSubnetTurnoverOutputSchema,
  },
  get_subnet_yield: {
    input: GetSubnetYieldInputSchema,
    output: GetSubnetYieldOutputSchema,
  },
  get_subnet_yield_history: {
    input: GetSubnetYieldHistoryInputSchema,
    output: GetSubnetYieldHistoryOutputSchema,
  },
  get_subnet_stake_flow: {
    input: GetSubnetStakeFlowInputSchema,
    output: GetSubnetStakeFlowOutputSchema,
  },
  get_subnet_event_summary: {
    input: GetSubnetEventSummaryInputSchema,
    output: GetSubnetEventSummaryOutputSchema,
  },
  get_subnet_weights: {
    input: GetSubnetWeightsInputSchema,
    output: GetSubnetWeightsOutputSchema,
  },
  get_subnet_weight_setters: {
    input: GetSubnetWeightSettersInputSchema,
    output: GetSubnetWeightSettersOutputSchema,
  },
  get_subnet_registrations: {
    input: GetSubnetRegistrationsMcpInputSchema,
    output: GetSubnetRegistrationsMcpOutputSchema,
  },
  get_subnet_stake_moves: {
    input: GetSubnetStakeMovesInputSchema,
    output: GetSubnetStakeMovesOutputSchema,
  },
  get_subnet_stake_transfers: {
    input: GetSubnetStakeTransfersInputSchema,
    output: GetSubnetStakeTransfersOutputSchema,
  },
  get_subnet_axon_removals: {
    input: GetSubnetAxonRemovalsMcpInputSchema,
    output: GetSubnetAxonRemovalsMcpOutputSchema,
  },
  get_subnet_serving: {
    input: GetSubnetServingMcpInputSchema,
    output: GetSubnetServingMcpOutputSchema,
  },
  get_subnet_prometheus: {
    input: GetSubnetPrometheusInputSchema,
    output: GetSubnetPrometheusOutputSchema,
  },
  get_subnet_deregistrations: {
    input: GetSubnetDeregistrationsMcpInputSchema,
    output: GetSubnetDeregistrationsMcpOutputSchema,
  },
  get_subnet_performance_history: {
    input: GetSubnetPerformanceHistoryInputSchema,
    output: GetSubnetPerformanceHistoryOutputSchema,
  },
  get_economics_trends: {
    input: GetEconomicsTrendsInputSchema,
    output: GetEconomicsTrendsOutputSchema,
  },
  get_registry_leaderboards: {
    input: GetRegistryLeaderboardsInputSchema,
    output: GetRegistryLeaderboardsOutputSchema,
  },
  get_domain_summary: {
    input: GetDomainSummaryInputSchema,
    output: GetDomainSummaryOutputSchema,
  },
  list_profiles: {
    input: ListProfilesInputSchema,
    output: ListProfilesOutputSchema,
  },
  get_subnet_profile: {
    input: GetSubnetProfileInputSchema,
    output: GetSubnetProfileOutputSchema,
  },
  compare_subnets: {
    input: CompareSubnetsInputSchema,
    output: CompareSubnetsOutputSchema,
  },
  get_subnet_metagraph: {
    input: GetSubnetMetagraphInputSchema,
    output: GetSubnetMetagraphOutputSchema,
  },
  get_subnet_history: {
    input: GetSubnetHistoryInputSchema,
    output: GetSubnetHistoryOutputSchema,
  },
  get_subnet_identity_history: {
    input: GetSubnetIdentityHistoryInputSchema,
    output: GetSubnetIdentityHistoryOutputSchema,
  },
  get_subnet_events: {
    input: GetSubnetEventsInputSchema,
    output: GetSubnetEventsOutputSchema,
  },
  get_subnet_hyperparams: {
    input: GetSubnetHyperparamsInputSchema,
    output: GetSubnetHyperparamsOutputSchema,
  },
  get_subnet_hyperparams_history: {
    input: GetSubnetHyperparamsHistoryInputSchema,
    output: GetSubnetHyperparamsHistoryOutputSchema,
  },
  get_subnet_volume: {
    input: GetSubnetVolumeInputSchema,
    output: GetSubnetVolumeOutputSchema,
  },
  get_subnet_ohlc: {
    input: GetSubnetOhlcInputSchema,
    output: GetSubnetOhlcOutputSchema,
  },
  get_subnet_ownership_history: {
    input: GetSubnetOwnershipHistoryInputSchema,
    output: GetSubnetOwnershipHistoryOutputSchema,
  },
  get_subnet_conviction: {
    input: GetSubnetConvictionInputSchema,
    output: GetSubnetConvictionOutputSchema,
  },
  get_subnet_recycled: {
    input: GetSubnetRecycledInputSchema,
    output: GetSubnetRecycledOutputSchema,
  },
  get_subnet_burn: {
    input: GetSubnetBurnInputSchema,
    output: GetSubnetBurnOutputSchema,
  },
  get_subnet_lease: {
    input: GetSubnetLeaseInputSchema,
    output: GetSubnetLeaseOutputSchema,
  },
  get_subnet_lease_history: {
    input: GetSubnetLeaseHistoryInputSchema,
    output: GetSubnetLeaseHistoryOutputSchema,
  },
};

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;

// Known, verified, DELIBERATE tightenings -- excluded from normalization so
// the diff surfaces them (as intended), and documented instead of silently
// erased. Keyed `${tool}.output.${dotted.property.path}`.
//
// get_subnet_stake_quote.output reuses SubnetStakeQuoteArtifactSchema
// wholesale (schemas-src/routes/stake-quote.ts) rather than re-declaring the
// shape -- the deliberate, documented full-fidelity-mirror case (see
// get-subnet-stake-quote.ts's header). That REST schema carries 5 numeric
// lower bounds (amount>0, matching the input side's own constraint;
// effective_price_tao/expected_out/price_impact_pct/spot_price_tao/netuid
// >= 0, real mathematical invariants of computeStakeQuote()'s output) the
// original
// bare MCP output schema never declared. None can ever reject a REAL
// response (computeStakeQuote() cannot produce a value outside these
// bounds) -- verified, not assumed.
const ACCEPTED_TIGHTENINGS = new Set([
  "get_subnet_stake_quote.output.amount",
  "get_subnet_stake_quote.output.effective_price_tao",
  "get_subnet_stake_quote.output.expected_out",
  "get_subnet_stake_quote.output.price_impact_pct",
  "get_subnet_stake_quote.output.spot_price_tao",
  "get_subnet_stake_quote.output.netuid",
]);

function normalize(node: unknown, path: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => normalize(item, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Row;

  // `type: [X, Y, ...]` (hand-written, one schema node, N-way union of bare
  // types), possibly with sibling constraint keys that apply ONLY to the
  // non-null branch (e.g. batch 4's get_subnet_lease.lease:
  // {type:["object","null"], properties:{...9 fields...}}) vs Zod's
  // `anyOf: [{type:X, ...siblings}, {type:Y}, ...]`. Earlier batches never
  // exercised the sibling case (their type:[X,Y] nodes were always bare,
  // e.g. NULLABLE_STRING) so this rewrite used to drop siblings outright;
  // batch 4 needs them carried into the first (non-null) branch, mirroring
  // scripts/diff-openapi-zod-components.ts's equivalent rule.
  if (Array.isArray(obj.type) && obj.type.length > 1) {
    const { type: _t, ...siblings } = obj;
    return normalize(
      {
        anyOf: obj.type.map((t, i) =>
          i === 0 ? { type: t, ...siblings } : { type: t },
        ),
      },
      path,
    );
  }

  const out: Row = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "description") continue; // issue-sanctioned cosmetic (#7863's own wording)

    if (
      ACCEPTED_TIGHTENINGS.has(path) &&
      (key === "exclusiveMinimum" || key === "minimum")
    ) {
      continue;
    }

    if (key === "required" && Array.isArray(value)) {
      out[key] = [...(value as string[])].sort();
      continue;
    }

    if (
      (key === "maximum" && value === MAX_SAFE_INT) ||
      (key === "minimum" && value === -MAX_SAFE_INT)
    ) {
      continue;
    }

    // additionalProperties: {} (Zod's .passthrough()) and
    // additionalProperties: true (hand-written) both mean "unrestricted" --
    // the SAME as omitting the key entirely (JSON Schema's own default).
    // Drop it outright rather than coercing to `true`, so a bare
    // `{type:"object"}` (hand-written, no properties/additionalProperties
    // at all) compares equal to Zod's `{type:"object", properties:{},
    // additionalProperties:{}}` for the same empty-passthrough-object case.
    if (
      key === "additionalProperties" &&
      (value === true ||
        (value && typeof value === "object" && Object.keys(value).length === 0))
    ) {
      continue;
    }

    // `items: {}` (Zod's z.array(z.unknown())) means "any item type" -- the
    // same as omitting `items` entirely (hand-written `{type:"array"}` with
    // no items constraint, e.g. get_subnet's gap_priorities).
    if (
      key === "items" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    if (
      key === "properties" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    out[key] = normalize(value, key === "properties" ? path : `${path}.${key}`);
  }

  if (Array.isArray(out.anyOf) && out.anyOf.length === 1) {
    Object.assign(out, out.anyOf[0]);
    delete out.anyOf;
  }

  return sortKeys(out);
}

function sortKeys(obj: Row): Row {
  const sorted: Row = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

let diffCount = 0;
for (const [name, { input: oldInput, output: oldOutput }] of Object.entries(
  OLD_SCHEMAS,
)) {
  const { input: newInputSchema, output: newOutputSchema } = NEW_SCHEMAS[name];
  for (const [kind, oldSchema, newSchema] of [
    ["input", oldInput, newInputSchema] as const,
    ["output", oldOutput, newOutputSchema] as const,
  ]) {
    const generated = z.toJSONSchema(newSchema, { target: "draft-2020-12" });
    const path = `${name}.${kind}`;
    const normalizedOld = JSON.stringify(
      sortKeys(normalize(oldSchema, path) as Row),
    );
    const normalizedNew = JSON.stringify(
      sortKeys(normalize(generated, path) as Row),
    );
    if (normalizedOld === normalizedNew) {
      console.log(`${path}: PASS`);
    } else {
      diffCount++;
      console.log(`${path}: DIFF`);
      console.log("  old (normalized):", normalizedOld);
      console.log("  new (normalized):", normalizedNew);
    }
  }
}

console.log(
  `\n${Object.keys(OLD_SCHEMAS).length * 2 - diffCount}/${Object.keys(OLD_SCHEMAS).length * 2} schemas PASS; ${diffCount} DIFF.`,
);
if (diffCount > 0) process.exit(1);
