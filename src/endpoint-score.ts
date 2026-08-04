// Endpoint pool scoring — the single definition, shared by the build-time artifact
// and the live 15-minute overlay (#9355).
//
// It used to live privately in scripts/lib/endpoint-artifacts.ts, which meant only the
// daily build could compute a score. The live overlay in src/health-serving.ts refreshed
// `status`, `latency_ms` and `pool_eligible` but left `score`/`score_reasons` as the
// build wrote them, with a comment saying that was safe because "a stale score never
// EXCLUDES an eligible endpoint ... only deprioritises it".
//
// That is true about exclusion and wrong about ranking, which is what the pool is FOR.
// Observed live on 2026-08-04, every finney-rpc endpoint at once:
//
//   https://fullnode-rpc.metagraph.sh   score=6 status=degraded  [latency +16, status-degraded -10]
//   https://archive.chain.opentensor.ai score=0 status=ok        [status-degraded -10]
//   https://lite.chain.opentensor.ai    score=0 status=ok        [status-degraded -10]
//   https://entrypoint-finney...        score=0 status=ok        [status-degraded -10]
//
// Four endpoints reporting `status: "ok"` while carrying a `status-degraded` penalty and
// no `status-ok` bonus — the reasons are from a build up to 24h earlier. The one ranked
// first was a host decommissioned weeks ago (metagraphed-infra#225) that answers
// Cloudflare 1033 on every request; it won on a stale latency sample.
//
// Scores are therefore recomputed wherever status is, from the same refreshed row.
// Untyped probe rows out of JSON artifacts. `unknown` rather than `any` so every
// field access below has to state what it expects.
type Row = Record<string, unknown>;

export interface ScoreBreakdown {
  score: number;
  reasons: Array<{ reason: string; points: number }>;
}

// Health classes, worst to best. Ordering by this BEFORE score is what makes the
// guarantee "an ok endpoint never sits below a non-ok one" hold structurally rather
// than as an emergent property of point arithmetic — the arithmetic clamps at 0
// (`Math.max(0, score)`), so a failed endpoint and a healthy-but-unmeasured one both
// land on 0 and their relative order falls through to latency, which is exactly how a
// dead host floated to the top.
const HEALTH_RANK: Record<string, number> = {
  ok: 3,
  unknown: 2,
  degraded: 1,
  failed: 0,
};

/** Higher is healthier. Unrecognised statuses sort with `unknown`. */
export function healthRank(status: unknown): number {
  const rank = HEALTH_RANK[String(status ?? "unknown")];
  return rank === undefined ? HEALTH_RANK.unknown : rank;
}

export function endpointScoreBreakdown(endpoint: Row): ScoreBreakdown {
  let score = 0;
  const reasons: Array<{ reason: string; points: number }> = [];
  function add(reason: string, points: number): void {
    score += points;
    reasons.push({ reason, points });
  }

  if (endpoint.status === "ok") add("status-ok", 50);
  if (endpoint.archive_support === true) add("archive-support", 15);
  if (endpoint.latest_block) add("latest-block-observed", 10);
  const methodSupport = endpoint.methods_supported || endpoint.method_support;
  if (
    methodSupport &&
    typeof methodSupport === "object" &&
    !Array.isArray(methodSupport)
  ) {
    add(
      "method-support",
      Math.min(Object.values(methodSupport).filter(Boolean).length * 5, 20),
    );
  } else if (Array.isArray(methodSupport)) {
    add("method-support", Math.min(methodSupport.length * 5, 20));
  }
  if (Number.isFinite(endpoint.latency_ms as number))
    add(
      "latency",
      Math.max(0, 20 - Math.round((endpoint.latency_ms as number) / 100)),
    );
  if (endpoint.auth_required) add("auth-required", -25);
  if (endpoint.status === "degraded") add("status-degraded", -10);
  if (endpoint.status === "failed") add("status-failed", -50);

  return {
    score: Math.max(0, score),
    reasons: reasons.filter((reason) => reason.points !== 0),
  };
}

/** True when this row's health was NOT confirmed by the most recent prober run. */
export function isHealthStale(endpoint: Row): boolean {
  return endpoint.health_stale === true;
}

/**
 * Pool ordering: healthiest class, then freshness, then score, then latency, then id.
 *
 * The health class leads because the score clamps at zero and therefore cannot express
 * "worse than nothing" — see HEALTH_RANK.
 *
 * Freshness is next because a class alone does not say when it was established. An
 * endpoint the last prober run did not cover keeps whatever the daily build recorded,
 * so a row can read `status: "ok"` on evidence up to 24h old. That is not equal to an
 * `ok` confirmed fifteen minutes ago, and ranking them equal is how a host that died
 * hours ago keeps a top slot until the next rebuild. Same class, confirmed first.
 *
 * `id` last keeps the order total and stable, so an artifact rebuild with unchanged
 * inputs produces byte-identical output.
 */
export function comparePoolEndpoints(a: Row, b: Row): number {
  return (
    healthRank(b.status) - healthRank(a.status) ||
    Number(isHealthStale(a)) - Number(isHealthStale(b)) ||
    ((b.score as number) || 0) - ((a.score as number) || 0) ||
    ((a.latency_ms as number) ?? 999999) -
      ((b.latency_ms as number) ?? 999999) ||
    String(a.id).localeCompare(String(b.id))
  );
}
