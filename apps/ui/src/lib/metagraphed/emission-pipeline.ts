import type { EmissionPipeline, EmissionPipelineSubnet } from "./types";

/**
 * Presentation logic for the v440 emission pipeline (#8745).
 *
 * The whole reason this is a module and not inline JSX: the page's hardest
 * requirement is a *classification*, not a layout. A subnet showing zero TAO
 * can be in three different states with three different meanings, and the
 * original framing of this feature (#8740) was wrong precisely because it
 * collapsed distinctions like this one. Getting it right is worth testing
 * directly rather than through a rendered table.
 */

/**
 * Which of the three mutually-exclusive states a row is in.
 *
 * `emission_enabled` and `ineligible_reason` are INDEPENDENT axes on the wire
 * — root (netuid 0) is `emission_enabled: true` and ineligible, while a
 * never-emitted subnet can be both disabled and ineligible. Ineligibility wins
 * here because it is the stronger statement: an ineligible subnet is not in
 * the pipeline at all, so its `final_share` is null rather than zero, and
 * calling it "disabled" would imply a switch someone could flip.
 */
export type EmissionRowState = "eligible" | "disabled" | "ineligible";

export function emissionRowState(subnet: EmissionPipelineSubnet): EmissionRowState {
  if (subnet.ineligible_reason) return "ineligible";
  return subnet.emission_enabled ? "eligible" : "disabled";
}

/** Human wording for an `ineligible_reason`, falling back to the raw code so an
 * unrecognized reason surfaces as itself rather than disappearing. */
export function ineligibleReasonLabel(reason: string): string {
  if (reason === "root") return "Root — outside the subnet pipeline";
  if (reason === "never_emitted") return "Never emitted";
  return reason;
}

/**
 * What the pipeline did to a subnet's share, as a direction. Deliberately NOT
 * "winners and losers": these are measurements, and the issue forbids
 * ranking-as-judgement. `gained`/`lost` describe the arithmetic only.
 */
export type GateDirection = "gained" | "lost" | "unchanged" | "unknown";

// A share is a fraction of 1 across ~130 subnets, so a "meaningful" move is
// small in absolute terms. 1e-9 is below the reconstruction's own stated
// subnet tolerance (2e-4) by orders of magnitude: this threshold only exists
// to keep floating-point dust out of the direction label, not to hide real
// movement.
const GATE_DELTA_EPSILON = 1e-9;

export function gateDirection(subnet: EmissionPipelineSubnet): GateDirection {
  const delta = subnet.gate_delta;
  if (delta == null) return "unknown";
  if (delta > GATE_DELTA_EPSILON) return "gained";
  if (delta < -GATE_DELTA_EPSILON) return "lost";
  return "unchanged";
}

export interface EmissionPipelineCounts {
  total: number;
  eligible: number;
  disabled: number;
  ineligible: number;
  gained: number;
  lost: number;
  /** Eligible, enabled, and gated all the way to zero — competing and
   * receiving nothing, which is NOT the same as switched off. */
  gatedToZero: number;
}

/**
 * Counts derived from the rows being displayed, not read from `aggregate`.
 *
 * `aggregate.disabled_count` counts emission-disabled subnets that are
 * otherwise eligible, so it excludes one that is both disabled AND ineligible
 * — a defensible definition, but it disagrees numerically with the row-level
 * count a reader can do by eye (44 vs 45 at block 8,754,718). Showing a total
 * the table itself contradicts is exactly the kind of small dishonesty that
 * makes a reader stop trusting the rest of the page, so the headline counts
 * come from the rows.
 */
export function emissionPipelineCounts(subnets: EmissionPipelineSubnet[]): EmissionPipelineCounts {
  const counts: EmissionPipelineCounts = {
    total: subnets.length,
    eligible: 0,
    disabled: 0,
    ineligible: 0,
    gained: 0,
    lost: 0,
    gatedToZero: 0,
  };
  for (const subnet of subnets) {
    const state = emissionRowState(subnet);
    if (state === "eligible") counts.eligible += 1;
    else if (state === "disabled") counts.disabled += 1;
    else counts.ineligible += 1;

    const direction = gateDirection(subnet);
    if (direction === "gained") counts.gained += 1;
    else if (direction === "lost") counts.lost += 1;

    if (state === "eligible" && subnet.gated_share === 0) counts.gatedToZero += 1;
  }
  return counts;
}

/**
 * How a subnet's TAO arrives. The issue's presentation rule: `tao_in = 0` with
 * `excess_tao > 0` means the subnet is receiving TAO as chain buys and MUST
 * NOT read as "receiving nothing".
 *
 * No subnet was in `chain-buys-only` at the block this was built against — but
 * the split is a per-block property of the reservoir, not a fixed attribute,
 * so the case is handled rather than assumed away.
 */
export type TaoChannelMix = "none" | "chain-buys-only" | "pool-only" | "both";

export function taoChannelMix(subnet: EmissionPipelineSubnet): TaoChannelMix {
  const pool = subnet.tao_in_emission ?? 0;
  const buys = subnet.excess_tao ?? 0;
  if (pool <= 0 && buys <= 0) return "none";
  if (pool <= 0) return "chain-buys-only";
  if (buys <= 0) return "pool-only";
  return "both";
}

export const EMISSION_SORT_KEYS = [
  "final_share",
  "emission_share",
  "gate_delta",
  "tao_total",
  "liquidity_fraction",
  "netuid",
] as const;

export type EmissionSortKey = (typeof EMISSION_SORT_KEYS)[number];

export function isEmissionSortKey(value: unknown): value is EmissionSortKey {
  return EMISSION_SORT_KEYS.includes(value as EmissionSortKey);
}

/**
 * Sort rows for display.
 *
 * Nulls always sort LAST regardless of direction. A null here means "this
 * subnet is not in the pipeline", and floating an out-of-pipeline row to the
 * top of an ascending sort would put a non-answer where the reader is looking
 * for the smallest real value. `netuid` breaks every tie so the order is
 * stable across renders.
 */
export function sortEmissionSubnets(
  subnets: EmissionPipelineSubnet[],
  key: EmissionSortKey,
  direction: "asc" | "desc",
): EmissionPipelineSubnet[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...subnets].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left == null && right == null) return a.netuid - b.netuid;
    if (left == null) return 1;
    if (right == null) return -1;
    if (left !== right) return (left - right) * sign;
    return a.netuid - b.netuid;
  });
}

export type EmissionStateFilter = "all" | EmissionRowState;

export function filterEmissionSubnets(
  subnets: EmissionPipelineSubnet[],
  state: EmissionStateFilter,
  query: string,
): EmissionPipelineSubnet[] {
  const netuidQuery = query.trim();
  return subnets.filter((subnet) => {
    if (state !== "all" && emissionRowState(subnet) !== state) return false;
    if (!netuidQuery) return true;
    return String(subnet.netuid).includes(netuidQuery);
  });
}

/**
 * The network TAO split, computed from the aggregate with a row-level
 * fallback.
 *
 * `liquidity_fraction` is served, but recomputing from the two channels when
 * it is absent keeps the headline renderable on a partial payload — and the
 * two must agree, since the headline is the page's single most-read number.
 */
export function networkTaoSplit(pipeline: EmissionPipeline): {
  poolFraction: number | null;
  buysFraction: number | null;
} {
  const { tao_in_emission: pool, excess_tao: buys, liquidity_fraction } = pipeline.aggregate;
  if (liquidity_fraction != null) {
    return { poolFraction: liquidity_fraction, buysFraction: 1 - liquidity_fraction };
  }
  if (pool == null || buys == null) return { poolFraction: null, buysFraction: null };
  const total = pool + buys;
  if (total <= 0) return { poolFraction: null, buysFraction: null };
  return { poolFraction: pool / total, buysFraction: buys / total };
}

/** Fields the response says were READ from chain storage rather than
 * reconstructed — the provenance the issue requires be traceable. */
export function measuredFields(pipeline: EmissionPipeline): string[] {
  return Object.entries(pipeline.field_sources)
    .filter(([, source]) => source.kind === "measured")
    .map(([field]) => field)
    .sort();
}
