// #10444: the revenue probe lane.
//
// Selects the surfaces that DECLARE readable revenue, fetches each, hashes what
// came back, extracts observations against the surface's own declaration
// (src/revenue-observation.ts), and hands back rows to persist. Everything is
// injected -- surfaces, fetch, hash, clock -- so the whole run is unit-testable
// without a runtime, the same shape src/health-prober.ts uses.
//
// Three rules the lane exists to hold:
//
//   1. ONLY READABLE PROVENANCE IS PROBED. `operator-attested` and
//      `third-party-reported` describe figures nobody outside the operator can
//      read; probing them would produce a 401 body and, under a careless
//      extractor, a number. They are skipped, not attempted.
//   2. A FETCH FAILURE IS A FAILURE. Never a zero, never a silently dropped
//      surface -- it comes back as a failure row with a reason, because a feed
//      that broke and a subnet that earned nothing are different facts.
//   3. THE RAW RESPONSE IS HASHED AND KEPT. An operator can withdraw a feed once
//      an unflattering ratio is published. A withdrawn feed that leaves nothing
//      behind is indistinguishable from a subnet that never had revenue.
import {
  extractRevenue,
  type RevenueDeclaration,
} from "./revenue-observation.ts";

/** The provenances that mean the payload WAS read, and so can be probed. */
export const READABLE_PROVENANCES = [
  "probe-derived",
  "chain-verified",
] as const;

/** Stored under `period` for a scalar total, which carries no period of its own.
 * A sentinel rather than NULL so the primary key stays total -- see 0016. */
export const SCALAR_PERIOD = "__total__";

export interface ProbeSurfaceInput {
  id: string;
  netuid: number;
  url: string;
  auth_required?: boolean;
  probe?: { enabled?: boolean };
  revenue?: RevenueDeclaration & {
    role?: string;
    provenance?: string;
    grain?: string;
  };
}

export interface RevenueObservationRow {
  surface_id: string;
  netuid: number;
  period: string;
  grain: string;
  amount: number;
  currency: string;
  provenance: string;
  response_hash: string;
  observed_at: number;
}

export interface RevenueFailureRow {
  surface_id: string;
  netuid: number;
  reason: string;
  observed_at: number;
  /**
   * Whether redelivering this message could ever produce a different answer.
   *
   * NOT PERSISTED -- the insert names its columns, and this is a routing fact
   * about the queue rather than something a reader of
   * `revenue_probe_failures` needs. It exists because the two failures this
   * lane records are opposites:
   *
   *   a FETCH failure is transient. The endpoint was slow, throttling, or
   *   briefly 5xx, and the next delivery may well succeed.
   *
   *   an EXTRACTION failure is deterministic. `expected an array payload`
   *   depends on the declaration and the payload's shape, neither of which a
   *   redelivery changes, so every retry re-fetches somebody else's API to
   *   write the identical row and then dead-letters.
   *
   * Measured 2026-08-11 (#10855): `sn-64-chutes-payments-list` declares
   * `flat-array` against a paginated envelope, failed extraction on every tick
   * for twelve hours, and held `revenue-probes-dlq` at `stale` the whole time.
   * The failure row was already on disk each time -- the retry added nothing
   * but load.
   */
  terminal: boolean;
}

export interface RevenueProbeResult {
  observations: RevenueObservationRow[];
  failures: RevenueFailureRow[];
  /** Surfaces the lane deliberately did not touch, and why. Reported rather than
   * silently omitted: a lane that quietly probes nothing looks identical to one
   * whose every surface passed. */
  skipped: Array<{ surface_id: string; reason: string }>;
}

export interface RevenueProbeDeps {
  /** Returns the parsed body and the exact text it was parsed from. Throwing is
   * a failure, not an exception the caller has to catch. */
  fetchPayload: (url: string) => Promise<{ payload: unknown; raw: string }>;
  hash: (raw: string) => Promise<string> | string;
  now: () => number;
}

/**
 * Is this surface one the lane should fetch?
 *
 * Exported because "which surfaces are in scope" is the decision most likely to
 * drift from the declaration rules, and it deserves its own tests rather than
 * only being exercised through a full run.
 */
export function probeEligibility(
  surface: ProbeSurfaceInput,
): { eligible: true } | { eligible: false; reason: string } {
  const revenue = surface.revenue;
  if (!revenue) return { eligible: false, reason: "no revenue declaration" };
  if (revenue.role !== "external-revenue") {
    return { eligible: false, reason: `role is ${revenue.role ?? "unset"}` };
  }
  const provenance = revenue.provenance ?? "";
  if (!(READABLE_PROVENANCES as readonly string[]).includes(provenance)) {
    return {
      eligible: false,
      reason: `provenance ${provenance || "unset"} is not readable`,
    };
  }
  // Mirrors validate-revenue-provenance.ts. The registry gate should make these
  // unreachable, but the lane must not fetch an auth-gated URL on the strength
  // of a declaration that slipped through.
  if (surface.auth_required === true) {
    return { eligible: false, reason: "auth_required" };
  }
  if (surface.probe?.enabled !== true) {
    return { eligible: false, reason: "probe.enabled is not true" };
  }
  return { eligible: true };
}

/**
 * Run one pass over the declared surfaces.
 *
 * Sequential on purpose: the eligible set is a handful of surfaces (two subnets
 * as of 2026-08-10), so there is nothing to gain from concurrency and a lane
 * that hammers a subnet's billing endpoint is a bad citizen. If the set grows,
 * bound it the way health-probe-core's mapLimit does rather than unbounding it.
 */
export async function runRevenueProbe(
  surfaces: ProbeSurfaceInput[],
  deps: RevenueProbeDeps,
): Promise<RevenueProbeResult> {
  const observations: RevenueObservationRow[] = [];
  const failures: RevenueFailureRow[] = [];
  const skipped: RevenueProbeResult["skipped"] = [];

  for (const surface of surfaces) {
    const eligibility = probeEligibility(surface);
    if (!eligibility.eligible) {
      skipped.push({ surface_id: surface.id, reason: eligibility.reason });
      continue;
    }
    const revenue = surface.revenue as NonNullable<
      ProbeSurfaceInput["revenue"]
    >;
    const observed_at = deps.now();
    let payload: unknown;
    let raw: string;
    try {
      ({ payload, raw } = await deps.fetchPayload(surface.url));
    } catch (error) {
      failures.push({
        surface_id: surface.id,
        netuid: surface.netuid,
        reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        observed_at,
        // Transient: a slow, throttling or briefly-5xx endpoint is worth
        // asking again.
        terminal: false,
      });
      continue;
    }
    const extracted = extractRevenue(revenue, payload);
    if (!extracted.ok) {
      failures.push({
        surface_id: surface.id,
        netuid: surface.netuid,
        reason: extracted.reason,
        observed_at,
        // Deterministic: the declaration and the payload's shape decide this,
        // and a redelivery changes neither.
        terminal: true,
      });
      continue;
    }
    const response_hash = await deps.hash(raw);
    for (const observation of extracted.observations) {
      observations.push({
        surface_id: surface.id,
        netuid: surface.netuid,
        period: observation.period ?? SCALAR_PERIOD,
        grain: revenue.grain ?? "cumulative",
        amount: observation.amount,
        currency: observation.currency,
        provenance: revenue.provenance as string,
        response_hash,
        observed_at,
      });
    }
  }

  return { observations, failures, skipped };
}
