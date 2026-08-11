// What a CALLER sees once the hot tier exists (#9208) -- REST, MCP, GraphQL.
//
// The measurement that opened the issue: against head 8,762,608, block
// 8,759,000 answered 29 extrinsics and block 8,762,600 answered 0. This file
// pins the two halves of the fix. A recent block the live-follow lane holds
// answers with rows; a recent block NOBODY holds answers 503 with a typed code,
// never 200-with-an-empty-list -- because an empty list and a block that
// genuinely had no extrinsics are the same bytes, and that is the bug.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10179), reached through `new Client(...)` inside
// src/read-store.ts. A route test cannot inject into that -- the caller is
// `handleRequest(request, env, ctx)` -- so the `pg` module is the seam. See
// tests/helpers/pg-mock.ts for why it is a module mock, and why the controller
// has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import { jsonBody } from "./row-type.ts";

const SEAM = DEFAULT_BLOCKS_SEAM; // 8_759_336
const RECENT = SEAM + 3_264; // 8,762,600 -- the block from the issue
const XT_HASH = `0x${"cd".repeat(32)}`;

beforeEach(() => {
  resetDecodeWatermarkCache();
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = null;
});

function extrinsicRow(index = 0) {
  return {
    block_number: RECENT,
    extrinsic_index: index,
    extrinsic_hash: XT_HASH,
    signer: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: 1,
    fee_tao: "0.0001",
    tip_tao: "0",
    call_args: null,
    observed_at: 1_785_800_000_000,
  };
}

function accountEventRow(index = 0) {
  return {
    block_number: RECENT,
    event_index: index,
    extrinsic_index: 0,
    event_kind: "StakeAdded",
    hotkey: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    coldkey: null,
    netuid: 1,
    uid: 3,
    amount_tao: "1.5",
    alpha_amount: "2.25",
    observed_at: 1_785_800_000_000,
  };
}

function chainEventRow(index = 0) {
  return {
    block_number: RECENT,
    event_index: index,
    pallet: "System",
    method: "ExtrinsicSuccess",
    args: null,
    phase: "ApplyExtrinsic",
    extrinsic_index: 0,
    observed_at: 1_785_800_000_000,
  };
}

/**
 * An env whose store holds the hot tier for `covered` blocks.
 *
 * `covered: []` is the GAP: the lane holds a window somewhere else (or nothing
 * at all) and this block is not in it.
 *
 * The per-statement answers are installed on the pg double's `onQuery`, which
 * fires before it consults its canned-answer list -- so assigning
 * `control.rows` from there is what makes one double answer a whole route's
 * worth of different statements. `onQuery` rather than a read-back because the
 * subscription is the only live view; see tests/helpers/pg-mock.ts.
 */
function envWith({
  covered,
  window,
}: {
  covered: number[];
  window?: { floor: number; head: number } | null;
}) {
  const registerWindow =
    window ??
    (covered.length
      ? { floor: Math.min(...covered), head: Math.max(...covered) }
      : null);
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.onQuery = ({ text, values }) => {
    const sql = text.replace(/\s+/g, " ").trim();
    pg.control.rows = ((): Record<string, unknown>[] => {
      if (sql.startsWith("SELECT MIN(block_number)"))
        return [
          registerWindow
            ? { ...registerWindow, observed: 1_785_800_000_000 }
            : { floor: null, head: null, observed: null },
        ];
      if (sql.includes("FROM chain_detail_blocks WHERE block_number"))
        return covered.includes(values[0] as number)
          ? [{ block_number: values[0] }]
          : [];
      if (sql.includes("FROM chain_detail_extrinsics"))
        return [extrinsicRow(), extrinsicRow(1)];
      if (sql.includes("FROM chain_detail_account_events"))
        return [accountEventRow()];
      if (sql.includes("FROM chain_detail_chain_events"))
        return [chainEventRow()];
      return [];
    })();
  };
  return { ...pgMockEnv() } as never;
}

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function json(res: Response) {
  return jsonBody(res);
}

describe("REST drill-down above the decode seam", () => {
  test("a covered recent block serves real extrinsics, not an empty list", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/extrinsics`),
      envWith({ covered: [RECENT] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.extrinsic_count, 2);
    assert.equal(body.data.block_number, RECENT);
    assert.equal(body.data.extrinsics[0].call_function, "set_weights");
  });

  test("a covered recent block serves its account events", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/events`),
      envWith({ covered: [RECENT] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.event_count, 1);
  });

  test("a GAP declines with a typed 503 naming both boundaries", async () => {
    for (const path of ["extrinsics", "events"]) {
      const res = await handleRequest(
        req(`/api/v1/blocks/${RECENT}/${path}`),
        envWith({
          covered: [],
          window: { floor: RECENT + 500, head: RECENT + 900 },
        }),
        {} as never,
      );
      assert.equal(res.status, 503);
      assert.equal(
        res.headers.get("x-metagraph-error-code"),
        "block_detail_unavailable",
      );
      // Never cached: a gap closes within the hour and a cached decline would
      // outlive it.
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await json(res);
      assert.equal(body.ok, false);
      assert.match(body.error.message, /not a block without/);
      assert.equal(body.meta.block_number, RECENT);
      assert.equal(body.meta.decoded_through, SEAM);
      assert.deepEqual(body.meta.hot_window, {
        from: RECENT + 500,
        to: RECENT + 900,
      });
    }
  });

  test("a gap with an EMPTY hot tier still declines, with a null window", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/extrinsics`),
      envWith({ covered: [] }),
      {} as never,
    );
    assert.equal(res.status, 503);
    assert.equal((await json(res)).meta.hot_window, null);
  });

  test("a block BELOW the seam is untouched by any of this", async () => {
    // The lakehouse owns it, has no R2 SQL token here, and the route keeps its
    // pre-#9208 schema-stable empty rather than declining.
    const res = await handleRequest(
      req(`/api/v1/blocks/${SEAM - 1000}/extrinsics`),
      envWith({ covered: [] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.extrinsic_count, 0);
    assert.equal(body.data.ref, String(SEAM - 1000));
  });

  test("CSV of a covered block carries the hot rows", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/extrinsics?format=csv`),
      envWith({ covered: [RECENT] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /set_weights/);
  });
});

describe("REST extrinsic detail", () => {
  test("the composite <block>-<index> form declines in the gap", async () => {
    const res = await handleRequest(
      req(`/api/v1/extrinsics/${RECENT}-0`),
      envWith({ covered: [], window: { floor: RECENT + 5, head: RECENT + 9 } }),
      {} as never,
    );
    assert.equal(res.status, 503);
    assert.equal(
      res.headers.get("x-metagraph-error-code"),
      "block_detail_unavailable",
    );
  });

  test("the composite form serves the hot row when covered", async () => {
    const res = await handleRequest(
      req(`/api/v1/extrinsics/${RECENT}-0`),
      envWith({ covered: [RECENT] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.extrinsic.call_function, "set_weights");
  });

  test("a HASH ref never declines -- absence from a small window proves nothing", async () => {
    const res = await handleRequest(
      req(`/api/v1/extrinsics/${XT_HASH}`),
      envWith({ covered: [] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    // The hot tier DOES hold this hash in the stub, so it answers with the row.
    assert.equal((await json(res)).data.extrinsic.extrinsic_hash, XT_HASH);
  });
});

describe("REST /blocks/{n}/chain-events", () => {
  test("a covered recent block is served from the hot tier, labelled as such", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/chain-events`),
      envWith({ covered: [RECENT] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.count, 1);
    assert.equal(body.data.block_number, RECENT);
    assert.equal(body.meta.source, "chain-detail-hot-tier");
  });

  test("a gap declines instead of degrading to the empty payload", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${RECENT}/chain-events`),
      envWith({ covered: [] }),
      {} as never,
    );
    assert.equal(res.status, 503);
    assert.equal(
      res.headers.get("x-metagraph-error-code"),
      "block_detail_unavailable",
    );
  });

  test("a block below the seam keeps the existing degraded empty", async () => {
    const res = await handleRequest(
      req(`/api/v1/blocks/${SEAM - 5}/chain-events`),
      envWith({ covered: [] }),
      {} as never,
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body.data, {
      block_number: SEAM - 5,
      count: 0,
      events: [],
    });
    assert.equal(body.meta.source, "data-worker-unavailable");
  });
});

describe("the MCP tools decline the same gap", () => {
  const tool = (name: string) => {
    const found = MCP_TOOLS.find((t) => t.name === name);
    assert.ok(found, `no ${name} tool`);
    return found;
  };

  const gapEnv = () => ({ env: envWith({ covered: [] }) }) as never;
  const coveredEnv = () => ({ env: envWith({ covered: [RECENT] }) }) as never;

  for (const [name, args] of [
    ["list_block_extrinsics", { ref: String(RECENT) }],
    ["get_block_events", { ref: String(RECENT) }],
    ["get_extrinsic", { ref: `${RECENT}-0` }],
    ["get_block_chain_events", { block_number: RECENT }],
  ] as const) {
    test(`${name} throws a tool error rather than returning an empty`, async () => {
      // An agent handed `extrinsics: []` will reason from it, and unlike a
      // person it will not click again in an hour.
      await assert.rejects(
        tool(name).handler(args as never, gapEnv()),
        (err: Error & { code?: string }) => {
          assert.equal(err.code, "block_detail_unavailable");
          assert.match(err.message, /not a block without/);
          return true;
        },
      );
    });
  }

  test("and serve the hot rows when the block IS covered", async () => {
    const extrinsics = (await tool("list_block_extrinsics").handler(
      { ref: String(RECENT) } as never,
      coveredEnv(),
    )) as Record<string, unknown>;
    assert.equal(extrinsics.extrinsic_count, 2);

    const events = (await tool("get_block_events").handler(
      { ref: String(RECENT) } as never,
      coveredEnv(),
    )) as Record<string, unknown>;
    assert.equal(events.event_count, 1);

    const chainEvents = (await tool("get_block_chain_events").handler(
      { block_number: RECENT } as never,
      coveredEnv(),
    )) as Record<string, unknown>;
    assert.equal(chainEvents.event_count, 1);
    assert.equal(chainEvents.block_number, RECENT);

    const detail = (await tool("get_extrinsic").handler(
      { ref: `${RECENT}-0` } as never,
      coveredEnv(),
    )) as Record<string, Record<string, unknown>>;
    assert.equal(detail.extrinsic.call_module, "SubtensorModule");
  });

  test("get_block_chain_events still validates its argument before any tier", async () => {
    await assert.rejects(
      tool("get_block_chain_events").handler(
        { block_number: -1 } as never,
        gapEnv(),
      ),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "invalid_params");
        return true;
      },
    );
  });
});

describe("GraphQL runs the same cascade", () => {
  // The third caller of `answerBlockDetail`, and the one #10394 changed: its
  // resolvers now pass the network through, and the network is what decides
  // whether the hot leg is consulted at all. REST and MCP pin the cascade
  // above; the GraphQL half of it was reached by no test, so the hot callbacks
  // its resolvers hand in could have been wired to the wrong loader and every
  // suite would still have passed on the cold answer underneath.
  async function gql(text: string, env: unknown) {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text }),
      }),
      env as never,
      {},
    );
    return jsonBody(res);
  }

  test("a covered recent block serves the hot rows", async () => {
    // The two rows publish differently: `events` is `[AccountEvent!]!` and
    // selects into subfields, `extrinsics` is still a bare `[JSON!]!` where the
    // row itself is the leaf. Each query below is written against what its
    // field actually publishes, so this reads as the asymmetry it is.
    const body = await gql(
      `{ block_extrinsics(ref: "${RECENT}") ` +
        `{ block_number extrinsic_count extrinsics { call_function } } }`,
      envWith({ covered: [RECENT] }),
    );
    assert.equal(body.errors, undefined);
    const detail = body.data.block_extrinsics;
    assert.equal(detail.block_number, RECENT);
    assert.equal(detail.extrinsic_count, 2);
    assert.equal(detail.extrinsics[0].call_function, "set_weights");

    const events = await gql(
      `{ block_events(ref: "${RECENT}") ` +
        `{ block_number event_count events { event_kind } } }`,
      envWith({ covered: [RECENT] }),
    );
    assert.equal(events.errors, undefined);
    assert.equal(events.data.block_events.event_count, 1);
    assert.equal(events.data.block_events.events[0].event_kind, "StakeAdded");
  });

  test("a GAP is an error with a typed code, not an empty block", async () => {
    // Same argument as the REST 503 and the MCP throw: `extrinsics: []` and "a
    // block that genuinely had none" are the same bytes to a client.
    for (const field of ["block_extrinsics", "block_events"]) {
      const body = await gql(
        `{ ${field}(ref: "${RECENT}") { block_number } }`,
        envWith({
          covered: [],
          window: { floor: RECENT + 500, head: RECENT + 900 },
        }),
      );
      assert.ok(body.errors, `${field} answered instead of declining`);
      assert.equal(
        body.errors[0].extensions.code,
        "BLOCK_DETAIL_UNAVAILABLE",
        `${field} declined with the wrong code`,
      );
      assert.equal(body.errors[0].extensions.block_number, RECENT);
    }
  });
});
