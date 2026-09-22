// Which store holds lane_health (#10126).
//
// Watchdogs share this seam so their writer and reader always select the same
// destination. D1 ownership is enabled only after copying and comparing the
// retained verdicts; its small current-state projection preserves the full
// history without making every health read scan it (#12151).
//
// ## Why it does not need a ctx, when everything else does
//
// createPgSql takes a `ctx` solely to hand the client back to Hyperdrive's pool
// WITHOUT the response waiting on it -- `ctx.waitUntil(client.end())`. That is a
// latency optimisation, not a correctness requirement.
//
// Sixteen of the writers are staleness watchdogs with no ctx in scope. Threading
// one through all of them, under time pressure, to save a few milliseconds on a
// fire-and-forget verdict write would be the riskier change by far. So this
// awaits the teardown instead: each operation opens, runs, and closes its own
// connection. Nothing to leak, no lifetime to manage, and no call site changes
// shape.
//
// Hyperdrive pools, so `connect()` is against the pool rather than a fresh TCP
// handshake -- which is what makes per-operation connections affordable here and
// would not be against a bare Postgres.
//
// ## Failure stays swallowed
//
// recordLaneVerdict already promises never to throw: a watchdog whose
// alarm-recording broke its alarm would be worse than the bug it watches for.
// This preserves that -- a failed verdict write is a dropped verdict, exactly as
// it is on the store today.
import { Client } from "pg";
import { toPositionalPlaceholders } from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import { hyperdriveConnectionString } from "./read-store.ts";
import { selectedD1Store } from "./d1-store.ts";

/** The minimal pg client this needs, so a test can hand it a fake. */
export interface LaneHealthPgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows?: unknown[] } | undefined>;
}

export interface LaneHealthStoreDeps {
  clientFactory?: (connectionString: string) => LaneHealthPgClient;
}

/** A LaneHealthDb over Postgres, one connection per operation. */
export function pgLaneHealthDb(
  connectionString: string,
  deps: LaneHealthStoreDeps = {},
): LaneHealthDb {
  const exec = async (text: string, values: unknown[]) => {
    const client =
      deps.clientFactory?.(connectionString) ??
      new Client({ connectionString });
    await client.connect();
    try {
      const result = await client.query(toPositionalPlaceholders(text), values);
      return (result?.rows ?? []) as Record<string, unknown>[];
    } finally {
      // Awaited, unlike createPgSql's waitUntil -- see this module's header.
      await client.end().catch(() => undefined);
    }
  };
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      return (await exec(text, values)) as Row[];
    },
    async run(text: string, values: unknown[] = []) {
      await exec(text, values);
      // The driver's rowCount is not read back here: recordLaneVerdict treats
      // any resolved run as landed, and the per-operation client closes before
      // a count could be consulted. Zero keeps the type honest without
      // claiming a count nobody measures.
      return { changes: 0 };
    },
  };
}

/**
 * The store lane_health verdicts should be written to and read from.
 *
 * `injected` wins outright so tests keep handing in their own fake. Otherwise
 * Explicit D1 ownership wins next; otherwise Hyperdrive remains the owner --
 * `undefined` when it is not, which recordLaneVerdict already treats as "no
 * store" rather than as an error.
 */
export function laneHealthStore(
  // `unknown`, not `Record<string, unknown>`: the intent above was always to be
  // loose enough for an `Env`, a bag or nothing, and a Record is not -- an
  // interface has no implicit index signature, so seven call sites holding a
  // real `Env` wrote `env` (#11339).
  env: unknown,
  injected?: LaneHealthDb | null,
  deps: LaneHealthStoreDeps = {},
): LaneHealthDb | undefined {
  if (injected) return injected;
  const d1 = selectedD1Store(env, ["lane_health"]);
  if (d1)
    return {
      ...d1,
      latest: () =>
        d1.query(
          "SELECT lane, verdict, age_ms, detail, checked_at FROM lane_health_current",
        ),
      maxGaps: (sinceMs, minimumSamples) =>
        d1.query(
          `SELECT lane, sampled - 1 AS n, max_gap FROM (
            SELECT c.lane,
              (SELECT COUNT(*) FROM (SELECT 1 FROM lane_health h
                WHERE h.lane = c.lane AND h.checked_at > ? LIMIT ?)) AS sampled,
              (SELECT gap FROM lane_health_clocks g WHERE g.lane = c.lane
                AND g.previous_at > ? ORDER BY gap DESC, checked_at DESC LIMIT 1) AS max_gap
            FROM lane_health_current c
          ) WHERE sampled > 1`,
          [sinceMs, minimumSamples, sinceMs],
        ),
      verdictRuns: (verdict) =>
        d1.query(
          `SELECT h.lane, MIN(h.checked_at) AS since, COUNT(*) AS ticks
            FROM lane_health_verdict_latest c CROSS JOIN lane_health h INDEXED BY idx_lane_health_verdict
              ON h.lane = c.lane AND h.verdict = c.verdict
              AND h.checked_at > COALESCE((SELECT MAX(x.checked_at)
                FROM lane_health_verdict_latest x
                WHERE x.lane = c.lane AND x.verdict <> c.verdict), 0)
            WHERE c.verdict = ? GROUP BY h.lane`,
          [verdict],
        ),
    };
  const connectionString = hyperdriveConnectionString(env);
  return connectionString ? pgLaneHealthDb(connectionString, deps) : undefined;
}
