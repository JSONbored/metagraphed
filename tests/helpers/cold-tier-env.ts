import { visibleInWindow } from "./block-window.ts";
// Transport doubles for the readers that answer now that the Postgres tier is
// gone (#10190).
//
// ## Why these, and why transport-level
//
// Before the sweep, a surface test proved "this field/tool/route serves what its
// reader returned" by doubling ONE transport: the DATA_API service binding, with
// `{ METAGRAPH_X_SOURCE: "postgres", DATA_API: { fetch } }`. Those flags read
// "retired"/"d1" in every deployed config and are absent from
// FORWARDABLE_TIER_FLAGS, so the binding was never asked and the assertion held
// over a payload production could not produce.
//
// The readers that DO answer reach three different transports, so there is no
// single replacement double:
//
//   METAGRAPH_ARCHIVE    the #9146 projection lanes (`load*FromArtifact`) --
//                        an R2 bucket read by object key
//   globalThis.fetch     the lakehouse cold tiers (`load*ColdTier`) -- R2 SQL
//                        over HTTP, one POST per query
//   HYPERDRIVE + pg      the live store (`readStore`) -- see helpers/pg-mock.ts
//
// These stay at the transport, deliberately. Mocking the loader module instead
// would be cheaper and strictly weaker: it would keep passing if a surface were
// wired to the wrong loader, or to none, which is the exact class of bug the
// sweep found (`run_saved_query` served an empty leaderboard for months because
// its tier arm had no rung under it).
//
// ## The envelope is the lane's, not ours
//
// Each projection reader validates the artifact body it reads and DECLINES
// (null) on anything else -- `schema_version !== 1`, a missing window, a totals
// object that is not an object. So `archiveEnv` takes the body verbatim rather
// than wrapping it: a test that hands over the wrong shape must fail, because in
// production that shape means "the lane did not write this" and the surface
// falls to its floor.

/** An object the artifact readers can `.json()`, or `null` for a miss. */
type ArchiveObject = { json(): Promise<unknown> } | null;

export interface ArchiveDouble {
  /** Every key asked for, in order -- so a network-scoped read is provable. */
  keys: string[];
  METAGRAPH_ARCHIVE: { get(key: string): Promise<ArchiveObject> };
}

/**
 * An env fragment whose archive answers with `body`.
 *
 * Pass a function to vary by key (a network-scoped projection reads
 * `<key>` on mainnet and `testnet/<key>` off it), or `null` for a bucket that
 * holds nothing -- which is how a reader's decline path is reached.
 */
export function archiveEnv(
  body: unknown | ((key: string) => unknown | null),
): ArchiveDouble {
  const keys: string[] = [];
  return {
    keys,
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        keys.push(key);
        const value = typeof body === "function" ? body(key) : body;
        if (value === null || value === undefined) return null;
        return { json: async () => value };
      },
    },
  };
}

/** The env key R2 SQL needs before the lakehouse leg is attempted at all. */
export const LAKEHOUSE_ENV = { R2_SQL_TOKEN: "cfut_test" };

export interface LakehouseDouble {
  /** Every SQL issued, verbatim -- so a dropped filter is provable. */
  queries: string[];
  /** Undo the global stub. Always call this, even on a failing assertion. */
  restore(): void;
}

/**
 * Stub the R2 SQL transport.
 *
 * `answer` receives the SQL and returns the rows for it, so a reader that issues
 * more than one query (the runtime timeline and its head block, the blocks
 * seam's two legs) can be answered per-query rather than with one list that
 * happens to satisfy both.
 *
 * THE BLOCK WINDOW IS HONOURED (#11131). Every scattered-key read on
 * `chain.account_events` widens a `block_number` window until its page fills,
 * so a double that replayed its list for each step handed back a page four
 * times too long, silently. Rows are now filtered to the window the query
 * actually asked for -- which is what a real lakehouse does, and what makes
 * these tests evidence about the reader instead of about the double.
 *
 * This replaced an `once: true` option that answered only the first query and
 * returned nothing after it. That was a blunt stand-in for the same thing --
 * it suppressed the duplicate rows without modelling why they appeared, and it
 * made a reader that legitimately widens look like one that failed to. Two
 * mechanisms for one property is worse than either alone.
 */
export function lakehouse(
  answer: unknown[] | ((sql: string) => unknown[]),
): LakehouseDouble {
  const original = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const sql = String(JSON.parse(String(init.body)).query);
    queries.push(sql);
    const rows = visibleInWindow(
      sql,
      typeof answer === "function" ? answer(sql) : answer,
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    queries,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * A DATA_API binding that fails the test if anything asks it.
 *
 * The counterpart to deleting a tier read: bind it, set the flag to the value
 * that WOULD forward, and assert `paths` stayed empty. Without this a
 * reintroduced `tryDataApiTier` call is invisible -- it returns null and the
 * surface answers from its fallback exactly as before.
 */
export function forbiddenDataApi() {
  const paths: string[] = [];
  return {
    paths,
    DATA_API: {
      fetch: async (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return Response.json({ schema_version: 1, marker: "tier" });
      },
    },
  };
}
