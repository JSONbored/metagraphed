// Shared queue-shaped D1 fake for the user-state route tests (the accounts /
// alert-trigger / push-subscription / TAO-USD families ported off box-Postgres
// in the accounts-d1 lane). It replaces those files' old `vi.mock("postgres")`
// queue at the SAME seam the production code moved to: workers/data-api.ts's
// createD1Sql runner calls env.METAGRAPH_HEALTH_DB.prepare(text).bind(...)
// .all(), so this fake implements exactly that surface and keeps the
// established per-test-queue semantics -- each test pushes the rows each of
// ITS statements (in order) should resolve to, and asserts on the recorded
// statement text/values.
//
// Recorded `values` are POST-coercion (what the runner actually hands
// D1.bind): booleans as 0/1, undefined as null, arrays/objects stringified --
// so assertions here exercise the runner's bind-coercion for free.
//
// Not a SQL-semantics emulator by design (matching the old postgres mock's
// convention); tests/data-api-user-state-d1.test.ts runs the same statements
// against a REAL SQLite database built from migrations/d1/0004_user_state.sql
// for dialect-level correctness.
import type { Row } from "./row-type.ts";

export interface UserStateD1Stores {
  mockQueue: { current: Row[][] };
  sqlCalls: Array<{ text: string; values: unknown[] }>;
  failNextQuery: { error: Error | null };
}

export function createQueueD1(stores: UserStateD1Stores): D1Database {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              stores.sqlCalls.push({ text, values });
              if (stores.failNextQuery.error) {
                const err = stores.failNextQuery.error;
                stores.failNextQuery.error = null;
                throw err;
              }
              return {
                results: stores.mockQueue.current.length
                  ? stores.mockQueue.current.shift()
                  : [],
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
