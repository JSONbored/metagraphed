import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// D1 mock routing by SQL shape: a ref (0x hash OR numeric) resolves to a
// block_number via `blocks`, then events are read from `account_events` by
// block_number (#1852). `blockNumber` null/absent → the block does not exist.
function dbWith({
  events,
  blockNumber,
}: {
  events?: Record<string, unknown>[];
  blockNumber?: number | null;
} = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (
                  /FROM blocks WHERE block_hash/.test(sql) ||
                  /FROM blocks WHERE block_number/.test(sql)
                )
                  return {
                    results:
                      blockNumber == null
                        ? []
                        : [{ block_number: blockNumber }],
                  };
                if (/FROM account_events/.test(sql))
                  return { results: events || [] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

const ROW = {
  block_number: 1_000_000,
  event_index: 0,
  event_kind: "WeightsSet",
  hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  coldkey: null,
  netuid: 7,
  uid: 3,
  amount_tao: null,
  observed_at: 1_750_009_000_000,
};

test("GET /blocks/{ref}/events honors ?limit and rejects bad params", async () => {
  const env = dbWith({ events: [ROW], blockNumber: 1_000_000 });
  const ok = await handleRequest(
    req("/api/v1/blocks/1000000/events?limit=10"),
    env as unknown as Env,
    {},
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.limit, 10);

  const bad = await handleRequest(
    req("/api/v1/blocks/1000000/events?bogus=1"),
    {} as unknown as Env,
    {},
  );
  assert.equal(bad.status, 400);
});

test("GET /blocks/{ref}/events is schema-stable for an unknown ref (never 404)", async () => {
  // Unknown 0x hash → blocks lookup empty → block_number null → events [].
  const hash = `0x${"b".repeat(64)}`;
  const env = dbWith({ blockNumber: null });
  const res = await handleRequest(
    req(`/api/v1/blocks/${hash}/events`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.block_number, null);
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.events), true);
});

test("GET /blocks/{number}/events resolves an unknown numeric ref to block_number null (not the ref)", async () => {
  // An unknown numeric block must resolve against `blocks` like a hash ref does,
  // so it reports block_number:null instead of echoing the requested number back
  // (mirrors handleBlockExtrinsics; #1953 fixed the extrinsics sibling).
  const env = dbWith({ blockNumber: null });
  const res = await handleRequest(
    req("/api/v1/blocks/777/events"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "777");
  assert.equal(body.data.block_number, null);
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.events), true);
});

test("GET /blocks/{number}/events ignores orphaned account_events when block is absent", async () => {
  const env = dbWith({ events: [ROW], blockNumber: null });
  const res = await handleRequest(
    req("/api/v1/blocks/1000000/events"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.block_number, null);
  assert.equal(body.data.event_count, 0);
  assert.deepEqual(body.data.events, []);
});
