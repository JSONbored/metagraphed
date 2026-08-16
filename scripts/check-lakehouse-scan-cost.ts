// What does each lakehouse-backed route actually COST to answer? (#11420)
//
// ## Why this exists, and why the latency numbers could not answer it
//
// #10312 timed 624 published operations and found 40 over a 5s budget. Every
// sub-issue under it is stated in wall-clock, and wall-clock cannot attribute
// a lakehouse read. Measured 2026-08-16, interleaved, five rounds, the SAME
// query against the SAME subject:
//
//   blocks point lookup      min 2.00s   median 11.74s   max 31.61s   15.8x
//   events block+idx         min 0.90s   median  2.80s   max  3.88s    4.3x
//
// The spread WITHIN one shape (15.8x) was wider than the spread BETWEEN the
// shapes being compared (9.4x). A single serial sample -- which is what the
// latency sweep takes, and says so -- cannot separate a slow query from a cold
// cache, so it cannot say which route is expensive.
//
// The engine has been reporting the answer on every response the whole time:
//
//   "metrics": { "bytes_scanned": 54240, "files_scanned": 20,
//                "r2_requests_count": 13, "cache_hits": 12 }
//
// `src/r2-sql.ts` parsed that block into `unknown` and dropped it. It is now
// typed (`schemas-src/r2-sql-envelope.ts`) and surfaced through the
// `onMetrics` hook, which is what this script reads.
//
// ## Why bytes and not seconds
//
// Scan cost does not move with cache state, so two runs of this script are
// comparable and two runs of the stopwatch are not. It is also the figure
// `scripts/validate-r2-sql-scan-bounds.ts` already reasons in -- that gate
// quotes 577.5 MB against 0.1 MB for a bounded vs unbounded predicate, from a
// manual probe nobody could repeat in production.
//
// ## Out of band, like its siblings
//
// It needs the live warehouse, so it cannot run on a pull request. `R2_SQL_*`
// come from the environment; without them every read declines and the report
// says so rather than printing zeros that look like cheap queries.
import { fileURLToPath } from "node:url";

import {
  CHAIN_PROMETHEUS_ROLLUP,
  CHAIN_SERVING_ROLLUP,
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventIdentityRollup,
  loadChainEventRollup,
} from "../src/chain-event-rollup-cold-tier.ts";
import { isR2SqlConfigured, r2SqlQuery } from "../src/r2-sql.ts";
import type { R2SqlEnv, R2SqlReader } from "../src/r2-sql.ts";
import type { R2SqlMetrics } from "../schemas-src/r2-sql-envelope.ts";

/** The subject every read asks about, so two runs compare like with like. */
const NETUID = 64;

/**
 * Which window to price, in days.
 *
 * PARAMETERISED because the answer depends on it and the default is easy to
 * misread: these routes publish 7d and 30d, `DEFAULT_ANALYTICS_WINDOW` is 7d,
 * and the latency sweep therefore measures 7d. Pricing only 30d reports a
 * worst case as if it were the common one.
 *
 *   node scripts/check-lakehouse-scan-cost.ts 7
 *   node scripts/check-lakehouse-scan-cost.ts 30
 */
const WINDOW_DAYS = Number(process.argv[2] ?? 7);

/**
 * Milliseconds to wait between routes.
 *
 * NOT cosmetic. Each loader fires its queries in one `Promise.all`, so running
 * the table back-to-back puts a burst on a warehouse this account has already
 * been rate-limited on (#9465, and the 429 storm that followed). A run with no
 * spacing reported `/chain/serving` completing ZERO queries in 15.00s -- which
 * reads exactly like "this route is catastrophically slow" and is actually the
 * probe throttling itself. Spacing separates the two.
 */
const SPACING_MS = Number(process.env.SCAN_COST_SPACING_MS ?? 4000);

interface Probe {
  /** The published route this read serves, for the report. */
  route: string;
  /** Which #10312 sub-issue it belongs to. */
  issue: string;
  /**
   * The real loader, handed the instrumented reader through its OWN `query`
   * seam -- the one it already exposes for tests. Nothing here rebuilds SQL: a
   * probe that retypes the query measures the probe, and would keep passing
   * after the loader's predicate changed underneath it.
   *
   * Only loaders carrying that seam are listed. `loadBlockFromR2Sql`,
   * `loadExtrinsicColdTier` and `loadSubnetOhlcColdTier` take positional
   * arguments and call `r2SqlQuery` directly, so measuring them faithfully
   * needs the seam added first -- deliberately not done here, because
   * reshaping three signatures for a diagnostic is the wrong order.
   */
  run: (env: R2SqlEnv, query: R2SqlReader) => Promise<unknown>;
}

/**
 * One entry per lakehouse-backed route named in #10312's over-budget list.
 *
 * Driven through the REAL loaders, never through SQL retyped here: a probe
 * that rebuilds the query measures the probe. When a loader's predicate
 * changes, this follows it.
 */
const PROBES: Probe[] = [
  {
    route: "/api/v1/chain/weights",
    issue: "#11418",
    run: (env, query) =>
      loadChainEventRollup(env, CHAIN_WEIGHTS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        query,
      }),
  },
  {
    route: "/api/v1/chain/weights/setters",
    issue: "#11418",
    run: (env, query) =>
      loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        query,
      }),
  },
  {
    route: "/api/v1/subnets/{netuid}/weights",
    issue: "#11418",
    run: (env, query) =>
      loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        netuid: NETUID,
        query,
      }),
  },
  {
    route: "/api/v1/chain/serving",
    issue: "#11419",
    run: (env, query) =>
      loadChainEventRollup(env, CHAIN_SERVING_ROLLUP, {
        windowDays: WINDOW_DAYS,
        query,
      }),
  },
  {
    route: "/api/v1/chain/prometheus",
    issue: "#11419",
    run: (env, query) =>
      loadChainEventRollup(env, CHAIN_PROMETHEUS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        query,
      }),
  },
  {
    route: "/api/v1/subnets/{netuid}/prometheus",
    issue: "#11419",
    run: (env, query) =>
      loadChainEventIdentityRollup(env, CHAIN_PROMETHEUS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        netuid: NETUID,
        query,
      }),
  },
  {
    route: "/api/v1/subnets/{netuid}/weights/setters",
    issue: "#11418",
    run: (env, query) =>
      loadChainEventIdentityRollup(env, CHAIN_WEIGHTS_ROLLUP, {
        windowDays: WINDOW_DAYS,
        netuid: NETUID,
        query,
      }),
  },
];

/** One route's totals, summed across every query the loader issued. */
interface Cost {
  route: string;
  issue: string;
  queries: number;
  bytes: number;
  files: number;
  requests: number;
  cacheHits: number;
  elapsedMs: number;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function measure(probe: Probe, env: R2SqlEnv): Promise<Cost> {
  const cost: Cost = {
    route: probe.route,
    issue: probe.issue,
    queries: 0,
    bytes: 0,
    files: 0,
    requests: 0,
    cacheHits: 0,
    elapsedMs: 0,
  };
  // The hook is per-QUERY and a loader may issue several (the rollup runs three
  // in one Promise.all, the extrinsic reader runs two serially), so the route's
  // cost is their sum -- which is what a caller pays and what no per-query
  // number would have shown.
  const onMetrics = (metrics: R2SqlMetrics) => {
    cost.queries += 1;
    cost.bytes += metrics.bytes_scanned ?? 0;
    cost.files += metrics.files_scanned ?? 0;
    cost.requests += metrics.r2_requests_count ?? 0;
    cost.cacheHits += metrics.cache_hits ?? 0;
  };
  // `r2SqlQuery` with the hook bound in -- assignable to R2SqlReader because
  // its row type parameter defaults, which is the same reason the loaders can
  // take it as their default.
  const instrumented: R2SqlReader = (readEnv, sql, deps) =>
    r2SqlQuery(readEnv, sql, { ...deps, onMetrics });
  const started = Date.now();
  await probe.run(env, instrumented);
  cost.elapsedMs = Date.now() - started;
  return cost;
}

async function main(): Promise<void> {
  // Typed as the reader's OWN env rather than cast into it: every field here
  // is already optional on R2SqlEnv, so there was never a type to erase.
  const env: R2SqlEnv = {
    R2_SQL_TOKEN: process.env.R2_SQL_TOKEN,
    R2_SQL_ACCOUNT_ID: process.env.R2_SQL_ACCOUNT_ID,
    R2_SQL_WAREHOUSE: process.env.R2_SQL_WAREHOUSE,
  };
  if (!isR2SqlConfigured(env)) {
    console.error(
      "R2_SQL_TOKEN / R2_SQL_ACCOUNT_ID / R2_SQL_WAREHOUSE are required -- " +
        "this reads the live warehouse. Without them every read declines and " +
        "the report would be zeros that look like cheap queries.",
    );
    process.exit(1);
  }

  const costs: Cost[] = [];
  for (const [i, probe] of PROBES.entries()) {
    if (i > 0 && SPACING_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
    }
    costs.push(await measure(probe, env));
  }
  costs.sort((a, b) => b.bytes - a.bytes);

  console.log(
    `window: ${WINDOW_DAYS}d (default is 7d), spacing ${SPACING_MS}ms\n`,
  );
  console.log(
    `${"route".padEnd(38)} ${"issue".padEnd(15)} ${"queries".padStart(7)} ` +
      `${"scanned".padStart(12)} ${"files".padStart(6)} ${"reqs".padStart(6)} ` +
      `${"cached".padStart(6)} ${"wall".padStart(8)}`,
  );
  for (const c of costs) {
    console.log(
      `${c.route.padEnd(38)} ${c.issue.padEnd(15)} ${String(c.queries).padStart(7)} ` +
        `${mib(c.bytes).padStart(12)} ${String(c.files).padStart(6)} ` +
        `${String(c.requests).padStart(6)} ${String(c.cacheHits).padStart(6)} ` +
        `${`${(c.elapsedMs / 1000).toFixed(2)}s`.padStart(8)}`,
    );
  }
  const total = costs.reduce((sum, c) => sum + c.bytes, 0);
  console.log(`\ntotal scanned across ${costs.length} routes: ${mib(total)}`);
  console.log(
    "wall is reported LAST and on purpose: it is the column that cannot be " +
      "compared between runs. Rank on `scanned`.",
  );
}

/* v8 ignore next 3 -- entry point: out-of-band, needs the live warehouse. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
