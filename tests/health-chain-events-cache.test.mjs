import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CHAIN_EVENTS_DB_TTL_MS,
  readChainEventsDb,
} from "../workers/api.mjs";

function mkDbEnv(row = { block: 100, at: 1_700_000_000_000 }) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                queries += 1;
                return { results: row ? [row] : [] };
              },
            };
          },
        };
      },
    },
  };
}

test("readChainEventsDb memoizes within the TTL — one D1 query for repeated calls", async () => {
  const env = mkDbEnv();
  const t0 = 5_000_000;
  const a = await readChainEventsDb(env, t0);
  const b = await readChainEventsDb(env, t0 + 1000);
  assert.deepEqual(a, b);
  assert.equal(
    env.queries,
    1,
    "a second call within the TTL must be served from the in-isolate memo",
  );

  await readChainEventsDb(env, t0 + CHAIN_EVENTS_DB_TTL_MS + 1);
  assert.equal(env.queries, 2, "an expired memo triggers a fresh D1 query");
});

test("readChainEventsDb never cross-reads a different env (isolation safety)", async () => {
  const envA = mkDbEnv({ block: 10, at: 1_000 });
  const envB = mkDbEnv({ block: 20, at: 2_000 });
  const t0 = 6_000_000;
  const a = await readChainEventsDb(envA, t0);
  const b = await readChainEventsDb(envB, t0);
  assert.equal(a?.block, 10);
  assert.equal(b?.block, 20);
  assert.equal(envA.queries, 1);
  assert.equal(envB.queries, 1);
});

test("readChainEventsDb returns null when health_db binding is absent", async () => {
  const result = await readChainEventsDb({}, 7_000_000);
  assert.equal(result, null);
});

test("readChainEventsDb does not cache a null result (no sticky cold miss)", async () => {
  let queries = 0;
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                queries += 1;
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  const t0 = 8_000_000;
  await readChainEventsDb(env, t0);
  await readChainEventsDb(env, t0 + 1000);
  assert.equal(queries, 2, "a null result must not be memoized");
});
