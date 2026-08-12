// Which store holds lane_health (#10126).
//
// ## Why this one is different from every other table
//
// lane_health is where all 27 watchdogs and mirror lanes record their verdicts,
// and it is the LAST table to move for exactly that reason: if it goes silent,
// every check goes silent with it, and an absent verdict reads as health. So
// this moves after everything it watches, and it must not need those 27 callers
// to change shape.
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
// it is on D1 today.
import { Client } from "pg";
import { toPositionalPlaceholders, type HyperdriveLike } from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";

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
      (new Client({ connectionString }) as unknown as LaneHealthPgClient);
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
 * Neon, once it is declared to own the table and Hyperdrive is bound --
 * `undefined` when it is not, which recordLaneVerdict already treats as "no
 * store" rather than as an error.
 */
export function laneHealthStore(
  // Deliberately loose: the callers hand in an `Env`, a bag, or nothing, and a
  // narrower type would push a cast to 27 call sites.
  env: Record<string, unknown> | Record<never, never> | null | undefined,
  injected?: LaneHealthDb | null,
  deps: LaneHealthStoreDeps = {},
): LaneHealthDb | undefined {
  if (injected) return injected;
  const hyperdrive = (env as Record<string, unknown> | null | undefined)
    ?.HYPERDRIVE as HyperdriveLike | undefined;
  if (hyperdrive?.connectionString) {
    return pgLaneHealthDb(hyperdrive.connectionString, deps);
  }
  return undefined;
}
