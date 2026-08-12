// Probing metagraphed's own components again (#9836).
//
// THE GAP THIS FILLS. `self_health_checks` and `self_health_daily` were written
// by a poller on the indexer box, and that box was decommissioned in #9193. The
// lakehouse kept a frozen copy of the daily rollup, so /api/v1/self-health has
// gone on serving 90 days of history whose newest day is 2026-08-02 -- a day
// that stopped 482 checks in.
//
// Since then the route has answered `current_ok: null` with a `degraded`
// verdict floor, and that was RIGHT: null means unmeasured, deliberately
// distinct from down, and inventing a current reading from the last frozen tick
// would state a probe nobody took. The endpoint was not lying. It had nothing
// to say, and this is what gives it something.
//
// A WORKER CRON, not a workflow. Data lanes do not live in GitHub Actions here
// (#9193 retired the last of them, and re-adding one makes a second writer);
// and a Worker probing its own public hostname exercises the same edge, DNS and
// TLS path a user's request takes, which is the thing being measured.
//
// WHAT "UP" MEANS PER COMPONENT, which is the part worth arguing:
//
//   api      a real data route, not /health. /health answers from bindings
//            alone and returns 200 while every read behind it is broken --
//            it is a liveness check, and self-health is asking a stronger
//            question.
//   site     the rendered homepage, which is a different origin and a
//            different failure mode from the API.
//   publish  an ARTIFACT, because the publish pipeline's failure is a stale
//            or missing artifact rather than a down host. A 200 on the site
//            says nothing about whether publishing still runs.
//
// EVERY OUTCOME IS A ROW. A timeout, a DNS failure and a 500 are all `ok:false`
// with the http_status that distinguishes them (null for "never got a
// response"). Writing nothing on failure is how an outage becomes an absence,
// and absence in this table means "not measured" -- the one claim that must
// stay honest, because the whole endpoint turns on it.
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { SELF_HEALTH_COMPONENTS } from "./self-health.ts";

export const SELF_HEALTH_PROBE_LANE = "self-health-probe";

/** How long a component gets before the probe calls it down. */
export const SELF_HEALTH_TIMEOUT_MS = 10_000;

/** The default timeout clock. Separated so a test can replace it -- see
 *  SelfHealthProberDeps.wait for why that is not optional hygiene. */
const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** What each component's probe actually requests. */
export const SELF_HEALTH_TARGETS: Readonly<Record<string, string>> = {
  // A data route rather than /health -- see this module's header.
  api: "https://api.metagraph.sh/api/v1/subnets?limit=1",
  site: "https://metagraph.sh/",
  publish: "https://api.metagraph.sh/api/v1/build",
};

export interface SelfHealthProbeResult {
  component: string;
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
}

export interface SelfHealthProberDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** The timeout clock, injectable.
   *
   * A test cannot rely on the default firing: setTimeout has been observed NOT
   * to run in this repo's worker test environment (the unresolved
   * webhook-retry-timer case), and this test hung for the full 30s vitest
   * budget in CI while passing locally. Injecting the wait tests the timeout
   * PATH without betting on a timer. */
  wait?: (ms: number) => Promise<void>;
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  timeoutMs?: number;
}

/** One component, probed once. Never throws: a probe that threw would take the
 *  other components down with it, and "we could not measure" is itself the
 *  answer this lane exists to record. */
export async function probeComponent(
  component: string,
  url: string,
  deps: SelfHealthProberDeps = {},
): Promise<SelfHealthProbeResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SELF_HEALTH_TIMEOUT_MS;
  const startedAt = now();
  try {
    const response = await Promise.race([
      doFetch(url, {
        // A cached 200 would report the edge's memory, not the origin's
        // health, and this lane's whole job is the origin.
        headers: { "cache-control": "no-cache" },
        redirect: "follow",
      }),
      (deps.wait ?? defaultWait)(timeoutMs).then((): never => {
        throw new Error("timeout");
      }),
    ]);
    const status = response.status;
    return {
      component,
      ok: status >= 200 && status < 400,
      http_status: status,
      latency_ms: Math.max(0, now() - startedAt),
    };
  } catch {
    // No response at all: DNS, TLS, connect, or the timeout above. `null`
    // status is not the same fact as a 5xx and is stored as its own thing.
    return {
      component,
      ok: false,
      http_status: null,
      latency_ms: Math.max(0, now() - startedAt),
    };
  }
}

export interface SelfHealthProbeOutcome {
  attempted: boolean;
  reason?: string;
  probed?: number;
  ok_count?: number;
}

/**
 * One tick: probe every component, write a tick each, and fold today's counts
 * into the daily rollup.
 *
 * The rollup is an UPSERT that adds, not a recount: recomputing the day from
 * `self_health_checks` would shrink it the moment the tick retention pruned
 * anything, and the rollup is kept for 90 days precisely to outlive its own
 * evidence.
 */
export async function runSelfHealthProbe(
  env: Record<string, unknown> | null | undefined,
  ctx?: WaitUntilLike | null,
  deps: SelfHealthProberDeps = {},
): Promise<SelfHealthProbeOutcome> {
  const now = deps.now ?? Date.now;
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);

  // The both-tables-or-neither ownership check collapsed with the flag
  // (#10051): Neon is the only store, so a half-owned family cannot exist and
  // the runner is the whole question.
  if (!sql) {
    const reason = "no postgres runner";
    await recordLaneVerdict(laneDb, {
      lane: SELF_HEALTH_PROBE_LANE,
      verdict: "stale",
      age_ms: null,
      detail: reason,
      checked_at: now(),
    });
    return { attempted: false, reason };
  }

  const results: SelfHealthProbeResult[] = [];
  for (const component of SELF_HEALTH_COMPONENTS) {
    const url = SELF_HEALTH_TARGETS[component];
    if (!url) continue;
    results.push(await probeComponent(component, url, deps));
  }

  const checkedAt = now();
  const day = new Date(checkedAt).toISOString().slice(0, 10);
  let written = 0;
  for (const result of results) {
    try {
      await sql.unsafe(
        `INSERT INTO self_health_checks
           (component, checked_at_ms, ok, http_status, latency_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (component, checked_at_ms) DO NOTHING`,
        [
          result.component,
          checkedAt,
          result.ok,
          result.http_status,
          result.latency_ms,
        ],
      );
      await sql.unsafe(
        `INSERT INTO self_health_daily (day, component, checks, ok_count)
         VALUES ($1::date, $2, 1, $3)
         ON CONFLICT (day, component) DO UPDATE SET
           checks = self_health_daily.checks + 1,
           ok_count = self_health_daily.ok_count + EXCLUDED.ok_count`,
        [day, result.component, result.ok ? 1 : 0],
      );
      written += 1;
    } catch (err) {
      console.error(
        `[self-health-probe] ${result.component} write failed:`,
        err,
      );
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const down = results.filter((r) => !r.ok).map((r) => r.component);
  await recordLaneVerdict(laneDb, {
    lane: SELF_HEALTH_PROBE_LANE,
    // The verdict is about the LANE, not about us: a tick that probed and
    // stored everything did its job even when what it found was an outage.
    // The outage is reported by the data, which is what /api/v1/self-health
    // reads. A lane that alarmed on a failing probe would conflate "we are
    // down" with "we cannot tell whether we are down".
    verdict: written === results.length ? "ok" : "stale",
    age_ms: null,
    detail:
      written === results.length
        ? `${okCount}/${results.length} ok${down.length ? `, down: ${down.join(",")}` : ""}`
        : `only ${written} of ${results.length} ticks stored`,
    checked_at: checkedAt,
  });

  return { attempted: true, probed: results.length, ok_count: okCount };
}
