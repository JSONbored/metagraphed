// The badge's reliability aggregate, and why it does not live in health-serving.
//
// It reads surface_uptime_daily through `loadSubnetUptime`, which lives in
// src/analytics-live.ts -- and analytics-live already imports
// src/health-serving.ts. Putting this back there closes that into a cycle, and
// the cycle is not merely untidy: analytics-live reaches
// workers/request-handlers/analytics-routes.ts and from there
// workers/responses.ts, whose module-level `SERVICE_DESC_LINK` template then
// evaluates before `PRIMARY_DOMAIN` is initialised. The build fails at the
// openapi-zod step with `Cannot access 'PRIMARY_DOMAIN' before initialization`
// -- a TDZ error hundreds of modules away from the import that caused it.
//
// src/badge.ts is the only consumer and nothing analytics-live reaches imports
// it, so this side of the edge is the one with no cycle to close.
import { scoreFromStats } from "./reliability.ts";
import { loadSubnetUptime } from "./analytics-live.ts";
import { readStore } from "./read-store.ts";
import { UPTIME_DAILY_TABLES } from "./read-store-tables.ts";

/** Cap on how many subnets a provider badge will aggregate over.
 *
 * One synthesized request per netuid (see below). A subnet badge -- the case
 * that matters, and the one the README flywheel is about -- is always exactly
 * one. This bounds the pathological provider spanning the whole registry;
 * beyond it the badge scores the first N by netuid rather than timing out. */
const RELIABILITY_BADGE_MAX_NETUIDS = 24;

/** The window the badge scores over.
 *
 * loadSubnetUptime's own default, stated rather than left implicit: the badge
 * used to inherit it from /api/v1/subnets/{netuid}/uptime's default and now
 * asks for it, so a change to that route's default cannot silently move what
 * the badge means. */
const RELIABILITY_BADGE_WINDOW = "90d";

/**
 * Sample-weighted reliability across one or many subnets, for the badge.
 *
 * This was a stub returning null from the 2026-07-17 D1 elimination onward --
 * its own comment said the table had "no Postgres-tier mirror wired for the
 * badge read path yet", so `?metric=uptime` and `?metric=grade` rendered "n/a"
 * for every subnet on earth. Confirmed live before this fix: SN64's badge said
 * `metagraphed: n/a` while /api/v1/subnets/64/uptime reported a real 0.9161
 * ratio at grade C from the same underlying data.
 *
 * There was never a missing mirror -- /api/v1/subnets/{netuid}/uptime already
 * serves exactly this, Postgres-tier, through METAGRAPH_HEALTH_SOURCE. So this
 * synthesizes an internal request per netuid rather than adding new plumbing,
 * the same "no client request to forward, synthesize one" shape handleCompare
 * uses for this table.
 *
 * Aggregation is sample-weighted, not a mean of ratios: a subnet with 30k
 * probes and one with 40 shouldn't count equally. Re-derives the composite via
 * scoreFromStats so the badge's grade bands can't drift from the ones
 * /uptime's own `reliability` block reports.
 */
export async function loadReliabilityAggregate(
  env: Env,
  { netuids }: { netuids: number[] },
): Promise<{ grade: string; uptime_ratio: number } | null> {
  const targets = netuids.slice(0, RELIABILITY_BADGE_MAX_NETUIDS);
  if (targets.length === 0) return null;

  const blocks = await Promise.all(
    targets.map(async (netuid) => {
      // THE LOADER, not a synthesized request through the tier (#10190).
      //
      // #8329 fixed the "n/a" badge by forwarding an internal
      // /api/v1/subnets/{netuid}/uptime request to the Postgres tier, because
      // that is where the route read from at the time. METAGRAPH_HEALTH_SOURCE
      // reads "d1" in wrangler.jsonc and is absent from FORWARDABLE_TIER_FLAGS,
      // so the forward stopped happening and every block came back null --
      // measured on production 2026-08-11, before this:
      //
      //   /api/v1/subnets/64/badge.svg?metric=uptime  ->  "metagraphed: n/a"
      //   /api/v1/subnets/64/uptime?window=90d        ->  grade C, 0.9296 over
      //                                                   78,896 samples
      //
      // The same table, the same second, two different answers. So this now
      // calls the loader the route itself calls, against the store readStore
      // picks -- one query per netuid, the same shape
      // src/surface-verification-sync.ts already uses for the same table, and
      // no internal request to keep in step with a route's plumbing.
      const data = (await loadSubnetUptime(netuid, {
        window: RELIABILITY_BADGE_WINDOW,
        db: readStore(env, UPTIME_DAILY_TABLES) as never,
      } as unknown as Parameters<typeof loadSubnetUptime>[1])) as {
        reliability?: Record<string, unknown> | null;
      } | null;
      return data?.reliability ?? null;
    }),
  );

  // Reconstruct ok-counts from ratio x samples: /uptime publishes the ratio and
  // the sample count, not the raw ok total.
  let samples = 0;
  let okCount = 0;
  let latencyWeighted = 0;
  let latencySamples = 0;
  for (const r of blocks) {
    if (!r) continue;
    const n = Number(r.sample_count);
    const ratio = Number(r.uptime_ratio);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(ratio)) continue;
    samples += n;
    okCount += ratio * n;
    const ls = Number(r.latency_sample_count);
    const avg = Number(r.avg_latency_ms);
    if (Number.isFinite(ls) && ls > 0 && Number.isFinite(avg)) {
      latencySamples += ls;
      latencyWeighted += avg * ls;
    }
  }
  if (samples === 0) return null;

  const scored = scoreFromStats({
    samples,
    okCount: Math.round(okCount),
    avgLatencyMs: latencySamples > 0 ? latencyWeighted / latencySamples : null,
    latencySamples,
  });
  // Total, not a fallback: scoreFromStats returns null only for samples === 0,
  // which the guard above already excluded. A `scored ? … : null` here would
  // be a branch that can never be taken.
  return { grade: scored!.grade, uptime_ratio: scored!.uptime_ratio };
}
