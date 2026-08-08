// A `pg` module double, for suites that used to hand a D1 binding to a route.
//
// ## Why this exists
//
// Before #10170 a route test built its store as `env.METAGRAPH_HEALTH_DB = <a
// prepare/bind/all fake over node:sqlite>`, and every selector took it. There
// is one store now, reached through `new Client({ connectionString })` inside
// src/read-store.ts, src/pg-sql.ts, src/pg-d1-adapter.ts and
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
}

/** `$1, $2, ...` -> `?`, so node:sqlite can parse what Postgres was handed. */
export function toQuestionMarks(text: string): string {
  return text.replace(/\$(\d+)/g, "?");
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
      if (!control.db) return { rows: [] };
      const statement = control.db.prepare(toQuestionMarks(text));
      // node:sqlite refuses `.all()` on a statement that returns nothing and
      // `.run()` on one that does, and the caller here does not know which it
      // has -- src/ issues INSERTs and SELECTs through the same `query`.
      try {
        return { rows: statement.all(...(values as never[])) };
      } catch {
        statement.run(...(values as never[]));
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
      default: { Client: MockClient, types: { setTypeParser: () => undefined } },
    },
  };
}

/** The env every mocked suite needs: a connection string for the selectors to
 * find, and every table declared Neon's so they do not decline. */
export function pgMockEnv(tables: readonly string[] = ALL_TABLES) {
  return {
    HYPERDRIVE: { connectionString: "postgresql://mock/db" },
    NEON_SOLE_STORE_TABLES: tables.join(","),
    NEON_READ_LANES: tables.join(","),
  };
}

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
  "emission_flow_watch",
  "lane_health",
  "account_balances",
  "account_balances_passes",
  "hotkey_alpha",
  "hotkey_alpha_passes",
  "self_health_checks",
  "self_health_daily",
] as const;
