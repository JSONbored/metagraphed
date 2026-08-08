// The chain-detail sync route and its head read (#9208), end to end through
// workers/data-api.ts, plus the workers/api.ts proxy in front of them.
//
// The ordering the handler gets right is worth a test of its own: a malformed
// body is a 400 whether or not a store happens to be bound, so the store check
// comes AFTER validation. Blaming the infrastructure for the caller's payload
// sends an operator to the wrong place.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// One store since #10170. Both halves of this route -- the batch write through
// mirrorChainDetailToNeon and the head read through readStore -- build their
// own `new Client(...)`, so the `pg` module is the only seam a route test has.
// See tests/helpers/pg-mock.ts for why it is a module mock built in vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import dataApi from "../workers/data-api.ts";
import { handleRequest } from "../workers/api.ts";

const SECRET = "test-chain-detail-sync-secret";
const HEADER = "x-chain-detail-sync-token";
/** A real ExecutionContext stand-in. Not optional any more: createPgSql parks
 * its connection teardown in `ctx.waitUntil`, so an empty object throws inside
 * the write's own `finally` and every table reports as failed. */
const CTX = { waitUntil: () => undefined } as never;
const HASH = `0x${"ab".repeat(32)}`;
const XT_HASH = `0x${"cd".repeat(32)}`;
const BLOCK = 8_762_600;

let statements: { sql: string; params: unknown[] }[] = [];
let failure: Error | null = null;
let head: number | null = BLOCK;

beforeEach(() => {
  statements = [];
  failure = null;
  head = BLOCK;
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  // A subscription rather than a read-back: `statements` is destructured-in-
  // spirit here too -- every assertion below reads it after the handler has
  // already returned. See tests/helpers/pg-mock.ts.
  pg.control.onQuery = ({ text, values }) => {
    const sql = text.replace(/\s+/g, " ").trim();
    statements.push({ sql, params: values });
    // Re-armed on every statement: a store that is refusing writes is refusing
    // them for the whole batch, not only for its first table.
    pg.control.failNext = failure;
    pg.control.rows = sql.startsWith("SELECT MIN(block_number)")
      ? [{ floor: head, head, observed: 1_785_800_000_000 }]
      : [];
  };
});

/** Only the chain-detail INSERTs, in issue order. The mirror also records a
 * lane verdict, which is a different lane's write and not what these assert. */
function insertedTables() {
  return statements
    .map((s) => /INSERT INTO (chain_detail_\w+)/.exec(s.sql)?.[1])
    .filter((t): t is string => Boolean(t));
}

// pgMockEnv carries both flags this route needs: NEON_DUAL_WRITE_LANES, without
// which the mirror is not even attempted, and NEON_SOLE_STORE_TABLES, without
// which the ack cannot claim the blocks are durable. Both are what
// wrangler.data.jsonc declares for this lane today.
const env = {
  CHAIN_DETAIL_SYNC_SECRET: SECRET,
  ...pgMockEnv(),
} as never;

function body(over: Record<string, unknown> = {}) {
  return {
    blocks: [
      {
        block_number: BLOCK,
        block_hash: HASH,
        observed_at: 1_785_799_000_000,
        spec_version: 291,
        extrinsics: [
          {
            block_number: BLOCK,
            extrinsic_index: 0,
            extrinsic_hash: XT_HASH,
            signer: null,
            call_module: "Timestamp",
            call_function: "set",
            success: null,
            fee_tao: null,
            tip_tao: null,
            call_args: '[{"name":"now","type":"u64","value":1785799000000}]',
            observed_at: 1_785_799_000_000,
          },
        ],
        chain_events: [
          {
            block_number: BLOCK,
            event_index: 0,
            pallet: "System",
            method: "ExtrinsicSuccess",
            args: null,
            phase: "ApplyExtrinsic",
            extrinsic_index: 0,
            observed_at: 1_785_799_000_000,
          },
        ],
        account_events: [],
        ...over,
      },
    ],
  };
}

function post(payload: unknown, opts: { secret?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.secret) headers[HEADER] = opts.secret;
  return dataApi.fetch(
    new Request("https://d/api/v1/internal/chain-detail-sync", {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(payload),
    }),
    env,
    CTX,
  );
}

function getHead(opts: { secret?: string; env?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.secret) headers[HEADER] = opts.secret;
  return dataApi.fetch(
    new Request("https://d/api/v1/internal/chain-detail-sync/head", {
      headers,
    }),
    (opts.env ?? env) as never,
    CTX,
  );
}

describe("POST /api/v1/internal/chain-detail-sync", () => {
  test("an authorised batch lands in the store and acks per family", async () => {
    const res = await post(body(), { secret: SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      blocks_written: 1,
      extrinsics_written: 1,
      chain_events_written: 1,
      account_events_written: 0,
      head: BLOCK,
      // One store: the `["d1"]` / `["d1","neon"]` acks the producer used to see
      // are unreachable now that a batch is refused outright unless Neon owns
      // all four tables, and `d1_statements` went with them -- a count of
      // statements against a store that no longer exists.
      stores: ["neon"],
    });
    assert.deepEqual(insertedTables(), [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      // account_events is empty in this batch, so no statement is issued for
      // it. The coverage register goes LAST, and only after the detail tables
      // it vouches for have landed.
      "chain_detail_blocks",
    ]);
  });

  test("an unprovisioned deployment is 503, a bad token is 401", async () => {
    const unprovisioned = await dataApi.fetch(
      new Request("https://d/api/v1/internal/chain-detail-sync", {
        method: "POST",
        headers: { [HEADER]: SECRET },
        body: "{}",
      }),
      { ...pgMockEnv() } as never,
      CTX,
    );
    assert.equal(unprovisioned.status, 503);

    assert.equal((await post(body(), {})).status, 401);
    assert.equal((await post(body(), { secret: "wrong" })).status, 401);
  });

  test("a malformed body is a 400 EVEN WITH NO STORE BOUND", async () => {
    // Validation before the store check: answering 503 to a bad payload blames
    // the infrastructure for the caller's mistake.
    const res = await dataApi.fetch(
      new Request("https://d/api/v1/internal/chain-detail-sync", {
        method: "POST",
        headers: { [HEADER]: SECRET },
        body: '{"blocks":[{"block_number":-1}]}',
      }),
      { CHAIN_DETAIL_SYNC_SECRET: SECRET } as never,
      CTX,
    );
    assert.equal(res.status, 400);
  });

  test("unparseable JSON, an oversized body, and a rejected row", async () => {
    const badJson = await post(null, { secret: SECRET, raw: "{not json" });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "body must be JSON" });

    const huge = await post(null, {
      secret: SECRET,
      raw: `{"pad":"${"x".repeat(16_000_001)}"}`,
    });
    assert.equal(huge.status, 413);

    const badRow = await post(body({ block_hash: "0xnope" }), {
      secret: SECRET,
    });
    assert.equal(badRow.status, 400);
  });

  test("a valid batch with no store bound is 503, not a silent success", async () => {
    const res = await dataApi.fetch(
      new Request("https://d/api/v1/internal/chain-detail-sync", {
        method: "POST",
        headers: { [HEADER]: SECRET },
        body: JSON.stringify(body()),
      }),
      { CHAIN_DETAIL_SYNC_SECRET: SECRET } as never,
      CTX,
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: "no store bound for this route",
    });
  });

  test("ONE table missing from the sole-store list is the same 503", async () => {
    // All four families land together or the block is readable and wrong, so a
    // partial declaration is the "no store" case rather than a weaker version
    // of owned -- and it must not be a 200 that acks blocks nothing holds.
    const partial = pgMockEnv([
      "chain_detail_blocks",
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
    ]);
    const res = await dataApi.fetch(
      new Request("https://d/api/v1/internal/chain-detail-sync", {
        method: "POST",
        headers: { [HEADER]: SECRET },
        body: JSON.stringify(body()),
      }),
      { CHAIN_DETAIL_SYNC_SECRET: SECRET, ...partial } as never,
      CTX,
    );
    assert.equal(res.status, 503);
    assert.deepEqual(insertedTables(), []);
  });

  test("a store write failure is a 502 with a capture label, never a 200", async () => {
    // The producer advances its resume head on `ok`, so a false 200 does not
    // just lose this batch -- it skips those blocks forever.
    failure = new Error("neon exploded");
    const res = await post(body(), { secret: SECRET });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "neon write failed" });
  });
});

describe("GET /api/v1/internal/chain-detail-sync/head", () => {
  test("reports the highest synced block, behind the same token", async () => {
    const res = await getHead({ secret: SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { head: BLOCK });

    assert.equal((await getHead({})).status, 401);
    // No secret provisioned at all, and a provisioned secret with no store
    // behind it: both are hard 503s. `head: null` is a documented real answer
    // that tells the producer to start from the finalized head, so "I cannot
    // tell you" must never be reported as it -- a 503 makes the producer
    // retry, a wrong null makes it skip and leave a hole nothing will fill.
    assert.equal(
      (await getHead({ secret: SECRET, env: { ...pgMockEnv() } })).status,
      503,
    );
    assert.equal(
      (
        await getHead({
          secret: SECRET,
          env: { CHAIN_DETAIL_SYNC_SECRET: SECRET },
        })
      ).status,
      503,
    );
  });

  test("an empty tier answers head:null -- a real answer, not an error", async () => {
    // The producer's correct response to null is "start from the finalized
    // head", which is exactly the state a first deploy is in.
    head = null;
    const res = await getHead({ secret: SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { head: null });
  });
});

describe("the workers/api.ts proxy", () => {
  function proxyEnv(seen: { path?: string; method?: string }) {
    return {
      DATA_API: {
        async fetch(request: Request) {
          seen.path = new URL(request.url).pathname;
          seen.method = request.method;
          return new Response(JSON.stringify({ ok: true, head: BLOCK }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as never;
  }

  test("forwards the POST verbatim, token header included", async () => {
    const seen: { path?: string; method?: string } = {};
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/chain-detail-sync",
        {
          method: "POST",
          headers: { [HEADER]: SECRET },
          body: JSON.stringify(body()),
        },
      ),
      proxyEnv(seen),
      {} as never,
    );
    assert.equal(res.status, 200);
    assert.equal(seen.path, "/api/v1/internal/chain-detail-sync");
    assert.equal(seen.method, "POST");
  });

  test("forwards the head GET, and refuses the wrong method on each route", async () => {
    const seen: { path?: string; method?: string } = {};
    const ok = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/chain-detail-sync/head",
        { headers: { [HEADER]: SECRET } },
      ),
      proxyEnv(seen),
      {} as never,
    );
    assert.equal(ok.status, 200);
    assert.equal(seen.method, "GET");

    // Each route accepts exactly one method: a GET on the write route and a
    // POST on the read route are both clean 405s, not silent forwards.
    const getWrite = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/internal/chain-detail-sync"),
      proxyEnv({}),
      {} as never,
    );
    assert.equal(getWrite.status, 405);
    assert.match(await getWrite.text(), /Only POST is supported/);

    const postRead = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/chain-detail-sync/head",
        { method: "POST", body: "{}" },
      ),
      proxyEnv({}),
      {} as never,
    );
    assert.equal(postRead.status, 405);
    assert.match(await postRead.text(), /Only GET is supported/);
  });

  test("an unbound DATA_API is a typed 503 on both routes", async () => {
    for (const path of [
      "/api/v1/internal/chain-detail-sync",
      "/api/v1/internal/chain-detail-sync/head",
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`, {
          method: path.endsWith("/head") ? "GET" : "POST",
          ...(path.endsWith("/head") ? {} : { body: "{}" }),
        }),
        {} as never,
        CTX,
      );
      assert.equal(res.status, 503);
      assert.equal(
        res.headers.get("x-metagraph-error-code"),
        "chain_detail_sync_unavailable",
      );
    }
  });
});
