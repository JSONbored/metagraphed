// A `pg` module double, for suites that used to hand a D1 binding to a route.
//
// ## Why this exists
//
// Before #10179 a route test built its store as `env.METAGRAPH_HEALTH_DB = <a
// prepare/bind/all fake over node:sqlite>`, and every selector took it. There
// is one store now, reached through `new Client({ connectionString })` inside
// src/read-store.ts, src/pg-sql.ts, src/producer-store.ts and
// src/lane-health-store.ts -- none of which a route caller can inject into,
// because the caller is `worker.fetch(request, env, ctx)`.
//
// Mocking the MODULE rather than adding a seam is deliberate. A
// `setClientFactoryForTests` export would put a hook in production code whose
// only caller is a test, and the thing it hooks -- "which client do we
// construct" -- is exactly what a module mock already owns. `vi.mock` is also
// per-test-file in vitest, so two suites installing different databases cannot
// see each other's.
//
// ## What the double has to get right
//
// PLACEHOLDERS. Postgres takes `$1, $2`; node:sqlite takes `?`. The code under
// test emits `$n` (pgStatementText, or toPositionalPlaceholders rewriting a
// handwritten `?`), so the SQL that arrives here is Postgres-shaped and has to
// be translated back before SQLite will parse it. Getting this wrong is silent:
// SQLite treats an unrecognised `$1` as a NAMED parameter and simply binds
// null, so a query would return zero rows rather than failing.
//
// RETURN SHAPE. `pg` answers `{ rows }`; D1 answered `{ results }`. Every
// caller in src/ reads `.rows` from this object, so that is what it returns --
// the `.results` shaping happens above, in pgReadStore.
import { DatabaseSync } from "node:sqlite";

export interface RecordedQuery {
  text: string;
  values: unknown[];
}

export interface PgMockController {
  /** Every query the code under test issued, in order, with its Postgres text
   * verbatim -- so a suite can still assert WHICH statement ran. */
  queries: RecordedQuery[];
  /** connect/end counts, so a leaked connection is visible: every one of these
   * modules is expected to close what it opens. */
  connects: number;
  ends: number;
  /** Answer the next query (and every one after it) from this list instead of
   * the database. Used by suites that never had a real engine to begin with. */
  rows: unknown[] | null;
  /** Per-statement canned answers, matched by substring against the SQL text.
   * First match wins; falls through to `rows`, then to the database. */
  answers: { match: string | RegExp; rows: unknown[] }[];
  /** Make the next query throw, so the failure path is reachable. */
  failNext: Error | null;
  /** Called with every query as it happens.
   *
   * A SUBSCRIPTION, not a getter, because the suites that need this destructure
   * their recorder -- `const { sql, params } = store(...)` -- and destructuring
   * evaluates a getter exactly once, at destructure time, freezing an empty
   * array. Pushing into arrays the suite already holds keeps them live. */
  onQuery: ((query: RecordedQuery) => void) | null;
  /** A real engine to answer from, when the suite has one. Assigned after
   * construction because `vi.hoisted` runs before anything else in the file. */
  db: DatabaseSync | null;
  /**
   * A REAL POSTGRES to answer from, taking precedence over `db` (#10328).
   *
   * `db` is node:sqlite, and reaching it costs a translation that only ever
   * subtracts meaning: `toQuestionMarks` rewrites the placeholders. A retired
   * companion, tests/helpers/pg-sqlite.ts, went further and DELETED EVERY `::`
   * cast so the statement would parse -- and those casts are load-bearing. A
   * bare parameter inside a `VALUES` list has no type context, so Postgres
   * resolves it to TEXT and the insert into an integer column fails, which
   * took the hotkey_alpha mirror down twice (#9832, #10000). A suite on that
   * path could not fail on it, because it never saw the cast. Every write-path
   * suite now uses `postgres` instead and the companion is gone.
   *
   * This seam takes the statement VERBATIM -- same `$n`, same casts, same
   * column-aliased VALUES relation -- so nothing between the code under test
   * and the engine can hide a dialect fault.
   *
   * Async because pglite is; `MockClient.query` was already async, so the
   * signature costs nothing. Suites still using `db` are untouched.
   */
  postgres: ((text: string, values: unknown[]) => Promise<unknown[]>) | null;
}

/** `$1, $2, ...` -> `?`, so node:sqlite can parse what Postgres was handed. */
export function toQuestionMarks(text: string): string {
  return text.replace(/\$(\d+)/g, "?");
}

/**
 * One bound value, as node:sqlite can accept it.
 *
 * A DRIVER-level type mapping, the same category as `$n` -> `?`, and not a
 * dialect rewrite. `pg` binds a JS boolean straight into a `boolean` column;
 * node:sqlite accepts no boolean at all -- it throws "Provided value cannot be
 * bound to SQLite parameter". So a statement that binds real booleans, which
 * every producer lane does now that Postgres is the only store (#10112's
 * storeBoolean always answers `true`/`false`), simply cannot execute against a
 * SQLite fixture without this. SQLite holds those columns as 0/1 and the
 * migrations' CHECK constraints are written against 0/1, so the mapping is
 * exact rather than lossy.
 *
 * `undefined` goes to null for the same reason on the other side: `pg` rejects
 * it outright, and a row merely missing a key is an ordinary shape here.
 *
 * THE RECORDED LOG KEEPS THE ORIGINAL VALUES -- this is applied on the way
 * into the engine only -- so a suite can still assert that a real boolean was
 * bound, which is the property the coercion would otherwise hide.
 */
function toSqliteValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value === undefined ? null : value;
}

/**
 * A `pg` double, answering from `control.db` (a node:sqlite database) or, when
 * there is none, from `control.answers` / `control.rows`.
 *
 * THE `vi.hoisted` WRAPPER IS NOT OPTIONAL. `vi.mock` is hoisted above every
 * import in the file, so a factory that closes over a plain `const` reads it
 * before initialisation and the suite fails to load. Build it like this:
 *
 *     const { pg } = await vi.hoisted(async () => ({
 *       pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
 *     }));
 *     vi.mock("pg", () => pg.module);
 *
 * Then assign the engine in a `beforeEach`: `pg.control.db = sqlite`.
 */
export function createPgMock() {
  const control: PgMockController = {
    queries: [],
    connects: 0,
    ends: 0,
    rows: null,
    answers: [],
    failNext: null,
    db: null,
    postgres: null,
    onQuery: null,
  };

  class MockClient {
    constructor(public config?: { connectionString?: string }) {}
    async connect() {
      control.connects += 1;
    }
    async end() {
      control.ends += 1;
    }
    async query(text: string, values: unknown[] = []) {
      const recorded = { text, values };
      control.queries.push(recorded);
      control.onQuery?.(recorded);
      if (control.failNext) {
        const error = control.failNext;
        control.failNext = null;
        throw error;
      }
      for (const answer of control.answers) {
        const hit =
          typeof answer.match === "string"
            ? text.includes(answer.match)
            : answer.match.test(text);
        if (hit) return { rows: answer.rows };
      }
      if (control.rows) return { rows: control.rows };
      // Postgres first: it needs no translation, so a suite that has one is
      // asking for the statement to be judged exactly as written.
      if (control.postgres) {
        return { rows: await control.postgres(text, values) };
      }
      if (!control.db) return { rows: [] };
      const statement = control.db.prepare(toQuestionMarks(text));
      const bound = values.map(toSqliteValue) as never[];
      // node:sqlite refuses `.all()` on a statement that returns nothing and
      // `.run()` on one that does, and the caller here does not know which it
      // has -- src/ issues INSERTs and SELECTs through the same `query`.
      try {
        return { rows: statement.all(...bound) };
      } catch {
        statement.run(...bound);
        return { rows: [] };
      }
    }
  }

  return {
    control,
    /** The shape `vi.mock("pg", () => ...)` must return. `types.setTypeParser`
     * is called at import time by src/pg-sql.ts, so it has to exist. */
    module: {
      Client: MockClient,
      types: { setTypeParser: () => undefined },
      default: {
        Client: MockClient,
        types: { setTypeParser: () => undefined },
      },
    },
  };
}

/**
 * The env every mocked suite needs.
 *
 * FOUR FLAGS, NOT ONE, and each answers a different question. Leaving any of
 * them out produces a suite that runs and asserts nothing:
 *
 *   HYPERDRIVE               can this isolate reach the store at all
 *   NEON_DUAL_WRITE_LANES    may a WRITER run for this lane
 *
 * The last one is the easiest to miss: without it `mirrorLedgerToNeon` and its
 * siblings answer `{ attempted: false }`, the queue consumer reads that as a
 * failed write and retries, and the suite sees a retry it will blame on the
 * consumer rather than on its own env.
 */
export function pgMockEnv(
  // Kept for call-site clarity about which tables a suite exercises; the
  // sole-store declaration this fed is gone (#10051).
  _tables: readonly string[] = ALL_TABLES,
  lanes: readonly string[] = ALL_LANES,
) {
  return {
    HYPERDRIVE: { connectionString: "postgresql://mock/db" },
    NEON_DUAL_WRITE_LANES: lanes.join(","),
  };
}

/** Every lane with a Neon writer, matching wrangler's own list. */
export const ALL_LANES = [
  "neurons",
  "nominator-positions",
  "account-balances",
  "hotkey-alpha",
  "validator-nominator-counts",
  "subnet-hyperparams",
  "account-identity",
  "chain-detail",
  "blocks-head",
  "raw-capture-state",
] as const;

/** Every table Neon solely owns, matching wrangler's own list -- so a suite
 * that does not care which tables it touches can just take all of them. */
export const ALL_TABLES = [
  "rpc_accounts",
  "github_accounts",
  "api_keys",
  "api_key_blocks",
  "api_key_usage_daily",
  "api_quota_daily",
  "api_usage_rollup",
  "chain_alert_triggers",
  "chain_alert_deliveries",
  "watch_push_subscriptions",
  "neurons",
  "neuron_daily",
  "account_position_daily",
  "surface_checks",
  "surface_status",
  "surface_uptime_daily",
  "surface_failure_daily",
  "subnet_snapshots",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "account_identity",
  "account_identity_history",
  "validator_nominator_counts",
  "chain_concentration_daily",
  "subnet_burn_history",
  "tao_usd_index",
  "nominator_positions",
  "nominator_positions_passes",
  "blocks_head",
  "raw_capture_state",
  "chain_detail_blocks",
  "chain_detail_extrinsics",
  "chain_detail_chain_events",
  "chain_detail_account_events",
  "neurons_passes",
  "validator_nominator_counts_passes",
  "emission_gate_param_history",
  "subnet_emission_enabled_history",
  "subnet_lifecycle",
  "emission_flow_watch",
  "lane_health",
  "account_balances",
  "account_balances_passes",
  "hotkey_alpha",
  "hotkey_alpha_passes",
  "self_health_checks",
  "self_health_daily",
  // The registry cluster. Declared Neon-owned in both wrangler configs, and
  // easy to forget here because nothing in this list is generated -- but
  // readStore is ALL-OR-NOTHING, so a suite taking bare pgMockEnv() for a
  // reader that touches one of these silently gets `undefined` and asserts
  // nothing at all.
  "subnets",
  "surfaces",
  "providers",
  "surface_history",
] as const;
