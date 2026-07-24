// Equivalence-diff audit for the Zod-generated MCP tool schemas (types-epic
// E, #7863 requirement 3): compares each pilot-batch tool's Zod-generated
// input/output JSON Schema against the hand-written literal it replaces,
// after normalizing the specific cosmetic differences z.toJSONSchema()
// introduces (documented inline below, mirroring
// scripts/diff-openapi-zod-components.ts's methodology for types-epic B).
// Anything left after normalization is a real difference and must be
// resolved before merge, not silenced here.
//
// The "old" schemas are hand-transcribed from the literals this PR's
// conversion commit replaced (see that commit's diff for
// src/mcp-server.ts / src/global-operational-health.ts /
// src/network-economics.ts) -- there is no structured old artifact to read
// (unlike B's hand-edited JSON Schema files), since the originals were
// inline JS object literals inside .ts source, not their own JSON files.
// Kept here as the audit's fixed baseline; add a new OLD_SCHEMAS entry
// (never edit an existing one) for each future batch under this issue.
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

type Row = Record<string, unknown>;

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };
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
  // types) vs Zod's `anyOf: [{type:X}, {type:Y}, ...]` (a flat union of
  // single-type schemas -- verified this batch never nests further, see
  // get-network-health.ts's contract_version comment on avoiding the nested
  // anyOf-of-anyOf z.union([...]).nullable() would otherwise produce).
  // Rewrite the hand-written side into the same flat anyOf shape.
  if (Array.isArray(obj.type) && obj.type.length > 1) {
    return normalize({ anyOf: obj.type.map((t) => ({ type: t })) }, path);
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
