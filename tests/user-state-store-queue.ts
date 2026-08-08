// Shared queue-shaped store fake for the user-state route tests (the accounts /
// alert-trigger / push-subscription families). It drives the `pg` module double
// in tests/helpers/pg-mock.ts, and it exists so those four suites keep the
// per-test-queue convention they were written against -- each test pushes the
// rows each of ITS statements (in order) should resolve to, and asserts on the
// recorded statement text/values.
//
// WHY IT MOVED. Until D1 was eliminated this file returned a D1Database whose
// prepare(text).bind(...).all() the production runner called. There is no D1
// binding to hand a route any more: workers/data-api.ts's `userStateRunner`
// returns `createPgSql(env.HYPERDRIVE, ctx)` and nothing else, and that reaches
// its store through `new Client({ connectionString })` -- which a caller going
// through `worker.fetch(request, env, ctx)` cannot inject into. So the seam is
// the `pg` MODULE, and this file is now the queue wired onto its controller
// rather than a binding of its own.
//
// THE WIRING IS A SUBSCRIPTION, NOT A GETTER, and that is load-bearing. Every
// one of these suites captures `sqlCalls` once at module scope and reads it
// after a request has run; a controller property read at wire time would freeze
// an empty array. `onQuery` fires per statement, so pushing into the arrays the
// suite already holds keeps them live. It also runs BEFORE the mock resolves an
// answer, which is what lets it shift the next row-set into place -- that
// ordering is the whole mechanism here.
//
// TWO THINGS CHANGED SHAPE FOR EVERY CALLER, both of them real:
//
//   * The recorded `text` is POSTGRES text. `pgStatementText` numbers the
//     tagged-template holes `$1, $2, ...` and `sql.unsafe` rewrites a
//     handwritten `?` through `toPositionalPlaceholders`, so an assertion
//     matching `= ?` is asserting the pre-#9821 bug -- six routes served zero
//     rows because `?` reached Postgres unrewritten. Those assertions are kept
//     and read `= $n`.
//   * The recorded `values` are RAW. createD1Sql used to coerce on the way to
//     `.bind()` (booleans to 0/1, objects stringified); `pg` takes the JS value
//     and serializes it itself, so a boolean stays a boolean for a Postgres
//     BOOLEAN column and an object reaches the driver as an object.
//
// Not a SQL-semantics emulator by design, matching the convention this file has
// always followed.
import type { PgMockController } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";

export interface UserStateStores {
  mockQueue: { current: Row[][] };
  sqlCalls: Array<{ text: string; values: unknown[] }>;
  failNextQuery: { error: Error | null };
}

/**
 * Point a `pg` double at a suite's per-test queue.
 *
 * Call once, at module scope, with the controller built inside `vi.hoisted`:
 *
 *     const { pg } = await vi.hoisted(async () => ({
 *       pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
 *     }));
 *     vi.mock("pg", () => pg.module);
 *     wireQueuedPg(pg.control, { mockQueue, sqlCalls, failNextQuery });
 */
export function wireQueuedPg(
  control: PgMockController,
  stores: UserStateStores,
): void {
  control.onQuery = (query) => {
    stores.sqlCalls.push(query);
    if (stores.failNextQuery.error) {
      // Handed to the mock's own one-shot failure slot rather than thrown from
      // here: `onQuery` is a notification, and a throw out of it would skip the
      // mock's own clearing of the slot.
      control.failNext = stores.failNextQuery.error;
      stores.failNextQuery.error = null;
      // The queue is deliberately NOT consumed by a statement that fails, so a
      // test can arrange a failure and a following answer independently.
      return;
    }
    // `[]` rather than null when the queue runs dry: an empty result set is a
    // real answer (no such row), and null would fall through to the mock's
    // database leg, which these suites do not have.
    control.rows = stores.mockQueue.current.length
      ? stores.mockQueue.current.shift()!
      : [];
  };
}
