// Unit tests for the Postgres-serving data Worker (workers/data-api.mjs). postgres.js
// is mocked so the routing + response shaping are tested with no real DB — the live
// Hyperdrive→Railway path is validated separately.
import { beforeEach, test, expect, vi } from "vitest";

const sqlCalls = vi.hoisted(() => []);
const mockRows = vi.hoisted(() => ({
  current: [
    {
      block_number: "123",
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "100",
    },
  ],
}));
// A per-test queue of results for handlers that issue more than one query per
// request (the new blocks/extrinsics detail routes: main row + a prev/next
// neighbor lookup, or main row + embedded account_events) -- each top-level
// sql`` call shifts the next queued result; once empty, falls back to the
// single shared `mockRows.current` (preserving every existing chain-events
// test's simpler one-shape-fits-all behavior unchanged).
const mockQueue = vi.hoisted(() => ({ current: [] }));

vi.mock("postgres", () => ({
  default: () => {
    // Every tagged-template call (top-level query OR nested fragment) resolves to rows;
    // the handler awaits the outer query and ignores interpolated fragment values.
    const sql = (strings, ...values) => {
      sqlCalls.push({ text: Array.from(strings).join("?"), values });
      if (mockQueue.current.length) {
        return Promise.resolve(mockQueue.current.shift());
      }
      return Promise.resolve(mockRows.current);
    };
    sql.end = () => Promise.resolve();
    // sql.begin(["read only",] cb) reserves a connection for cb in real
    // postgres.js; the mock just invokes cb with this same sql function so
    // every existing tagged-template assertion (sqlCalls, mockQueue) still
    // sees the identical call stream, and resolves to whatever cb returns.
    sql.begin = (optionsOrCb, maybeCb) => {
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      return cb(sql);
    };
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");
const env = { HYPERDRIVE: { connectionString: "postgres://mock" } };
const ctx = { waitUntil() {} };
const req = (path, init) =>
  worker.fetch(new Request(`https://d${path}`, init), env, ctx);
const queryText = () => sqlCalls.map((call) => call.text).join("\n");

beforeEach(() => {
  sqlCalls.length = 0;
  mockQueue.current = [];
  mockRows.current = [
    {
      block_number: "123",
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "100",
    },
  ];
});

test("chain-events coerces blank bigint cells to null, not zero", async () => {
  mockRows.current = [
    {
      block_number: "",
      event_index: "   ",
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "",
    },
  ];
  const res = await req("/api/v1/chain-events?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].block_number).toBeNull();
  expect(body.events[0].observed_at).toBeNull();
  // Blank seek keys must not produce a lossless cursor token.
  expect(body.next_cursor).toBeNull();
});

test("chain-events coerces null and non-numeric bigint cells to null", async () => {
  mockRows.current = [
    {
      block_number: null,
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "not-a-number",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].block_number).toBeNull();
  expect(body.events[0].observed_at).toBeNull();
});

test("GET /api/v1/blocks/:n/chain-events returns the block's events", async () => {
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block_number).toBe(123);
  expect(body.count).toBe(1);
  expect(body.events[0].pallet).toBe("System");
  expect(body.events[0].method).toBe("ExtrinsicSuccess");
  // observed_at is coerced from the postgres.js BIGINT string to a number.
  expect(body.events[0].observed_at).toBe(100);
  expect(typeof body.events[0].observed_at).toBe("number");
});

// #4685: chain_events.args decodes AccountId32 byte arrays to SS58 (or hex
// for non-account/untagged values) -- fixtures below are real production
// rows, independently re-verified directly against Postgres during this
// session, not synthetic examples.
test("chain-events decodes an account-keyed field (TransactionFeePaid.who) to SS58", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      event_index: 412,
      pallet: "TransactionPayment",
      method: "TransactionFeePaid",
      args: {
        tip: 0,
        who: [
          [
            230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
            251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
            143, 88,
          ],
        ],
        actual_fee: 2131419,
      },
      phase: "ApplyExtrinsic",
      extrinsic_index: 200,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/chain-events?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args.who).toBe(
    "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
  );
  expect(body.events[0].args.tip).toBe(0);
  expect(body.events[0].args.actual_fee).toBe(2131419);
});

test("chain-events decodes both account-keyed fields of a Balances.Transfer (to and from)", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      event_index: 119,
      pallet: "Balances",
      method: "Transfer",
      args: {
        to: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
        from: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 15, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
        amount: 30681,
      },
      phase: "ApplyExtrinsic",
      extrinsic_index: 100,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args.to).toBe(
    "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  );
  expect(body.events[0].args.from).toBe(
    "5EYCAe5jLQhn6ofDSvuKE7htj4zVF4Tq1J7DTNzTePVJucfX",
  );
  expect(body.events[0].args.amount).toBe(30681);
});

test("chain-events hex-encodes an untagged positional 32-byte value (no field name to key SS58 off of)", async () => {
  // Real SubtensorModule.TimelockedWeightsRevealed row (block 8587756, event
  // 2): args has no field names at all for non-System/Balances pallets --
  // must degrade to hex, never guess an SS58 address with no key hint.
  mockRows.current = [
    {
      block_number: "8587756",
      event_index: 2,
      pallet: "SubtensorModule",
      method: "TimelockedWeightsRevealed",
      args: [
        78,
        [
          [
            162, 193, 121, 87, 196, 67, 129, 183, 243, 158, 111, 10, 171, 37,
            31, 122, 9, 152, 89, 131, 234, 97, 249, 41, 16, 168, 179, 154, 146,
            252, 209, 69,
          ],
        ],
      ],
      phase: "ApplyExtrinsic",
      extrinsic_index: 50,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args).toEqual([
    78,
    "0xa2c17957c44381b7f39e6f0aab251f7a09985983ea61f92910a8b39a92fcd145",
  ]);
});

test("GET /api/v1/chain-events returns the feed with a cursor (filters + before)", async () => {
  const res = await req(
    "/api/v1/chain-events?limit=1&pallet=System&method=ExtrinsicSuccess&before=500",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(body.next_before).toBe(123); // rows.length === limit → cursor is the last row
  expect(body.next_cursor).toBe("123.0"); // lossless block_number.event_index cursor
  // BIGINT columns are coerced from postgres.js strings to numbers (D1-route parity).
  expect(body.events[0].block_number).toBe(123);
  expect(typeof body.events[0].block_number).toBe("number");
  expect(body.events[0].observed_at).toBe(100);
  expect(typeof body.events[0].observed_at).toBe("number");
});

test("chain-events cursor seeks by block_number and event_index", async () => {
  const res = await req("/api/v1/chain-events?limit=1&cursor=123.4&before=500");
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND (block_number, event_index) < (?, ?)");
  expect(queryText()).not.toContain("AND block_number <");
  const cursorCall = sqlCalls.find((call) =>
    call.text.includes("(block_number, event_index) <"),
  );
  expect(cursorCall.values).toEqual([123, 4]);
});

test("limit is clamped and defaults safely", async () => {
  const res = await req("/api/v1/chain-events?limit=99999");
  expect(res.status).toBe(200); // clamp to MAX_LIMIT, no error
});

test("chain-events preserves a minimum limit after flooring a fractional value", async () => {
  // A fractional 0<n<1 limit floored to 0 binds LIMIT 0 and then dereferences
  // rows[-1] for the cursor (TypeError → 502); it must clamp up to 1 instead.
  const res = await req("/api/v1/chain-events?limit=0.5");
  expect(res.status).toBe(200);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(0);
});

test("chain-events accepts block + extrinsic filters (extrinsic-detail view)", async () => {
  const res = await req("/api/v1/chain-events?block=5870000&extrinsic=3");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(queryText()).toContain("AND block_number =");
  expect(queryText()).toContain("AND extrinsic_index =");
  // non-numeric filter values are ignored, not errors:
  const res2 = await req("/api/v1/chain-events?block=abc&extrinsic=");
  expect(res2.status).toBe(200);
});

test("chain-events ignores malformed integer position filters", async () => {
  const cases = [
    "/api/v1/chain-events?block=1.5&extrinsic=2&before=3",
    "/api/v1/chain-events?block=-1&extrinsic=2&before=3",
    "/api/v1/chain-events?block=1e3&extrinsic=2&before=3",
    "/api/v1/chain-events?block=9007199254740993&extrinsic=2&before=3",
    "/api/v1/chain-events?block=12&extrinsic=3.5",
    "/api/v1/chain-events?block=12&extrinsic=-3",
    "/api/v1/chain-events?before=3.5",
    "/api/v1/chain-events?before=-3",
    "/api/v1/chain-events?before=1e3",
    "/api/v1/chain-events?before=9007199254740993",
  ];

  for (const path of cases) {
    sqlCalls.length = 0;
    const res = await req(path);
    expect(res.status).toBe(200);
    const values = sqlCalls.flatMap((call) => call.values);
    expect(values).not.toContain(1.5);
    expect(values).not.toContain(3.5);
    expect(values).not.toContain(-1);
    expect(values).not.toContain(-3);
    expect(values).not.toContain(1000);
  }
});

test("chain-events ignores extrinsic without block to avoid global scans", async () => {
  const res = await req("/api/v1/chain-events?extrinsic=999999&limit=1");
  expect(res.status).toBe(200);
  expect(queryText()).not.toContain("AND extrinsic_index =");
  expect(queryText()).not.toContain("AND block_number =");
});

test("chain-events rejects method-only feed filters without a block scope", async () => {
  const res = await req("/api/v1/chain-events?method=ExtrinsicSuccess");
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/method filter requires pallet/);
});

test("chain-events/stats returns the activity aggregate with a clamped window", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=500");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(500);
  expect(Array.isArray(body.activity)).toBe(true);
  // window clamps: oversized → 5000, non-numeric → default 1000
  expect(
    (await (await req("/api/v1/chain-events/stats?blocks=99999")).json())
      .window_blocks,
  ).toBe(5000);
  expect(
    (await (await req("/api/v1/chain-events/stats?blocks=abc")).json())
      .window_blocks,
  ).toBe(1000);
});

test("chain-events/stats ranks with a deterministic tie-break on the group key", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=500");
  expect(res.status).toBe(200);
  // count is non-unique; the ranking must tie-break on the GROUP BY key so the
  // order and the LIMIT 100 boundary membership are stable across identical
  // requests rather than left to Postgres' unordered equal-count grouping.
  const stats = sqlCalls.at(-1).text;
  expect(stats).toContain("ORDER BY count DESC, pallet ASC, method ASC");
  expect(stats).not.toMatch(/ORDER BY count DESC\s+LIMIT/);
});

test("chain-events/stats floors fractional blocks before binding", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=1.5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(1);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(1.5);
});

test("chain-events/stats preserves minimum block window after flooring", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=0.5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(1);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(0);
});

test("chain-events rejects overlong or non-enumerable pallet/method filters", async () => {
  const res = await req(`/api/v1/chain-events?pallet=${"A".repeat(65)}`);
  expect(res.status).toBe(400);
  const punct = await req("/api/v1/chain-events?pallet=System;DROP");
  expect(punct.status).toBe(400);
});

// ---- D1 serving-cutover routes (#4656 followup): blocks + extrinsics -------

const BLOCK_ROW = {
  block_number: "8586300",
  block_hash: "0xabc",
  parent_hash: "0xdef",
  author: "5Author",
  extrinsic_count: 5,
  event_count: 10,
  spec_version: 424,
  observed_at: "1783600000000",
};

const EXTRINSIC_HASH = `0x${"a".repeat(64)}`;

const EXTRINSIC_ROW = {
  block_number: "8586300",
  extrinsic_index: 2,
  extrinsic_hash: EXTRINSIC_HASH,
  signer: "5Signer",
  call_module: "SubtensorModule",
  call_function: "set_weights",
  call_args: '{"a":1}', // simulates the ::text cast of a JSONB column
  success: true,
  fee_tao: "0.01",
  tip_tao: "0",
  observed_at: "1783600000000",
};

const SS58 = "5Hot";
const ACCOUNT_EVENT_ROW = {
  block_number: "8586300",
  event_index: 0,
  extrinsic_index: 2,
  event_kind: "StakeAdded",
  hotkey: SS58,
  coldkey: "5Cold",
  netuid: 4,
  uid: 1,
  amount_tao: "1.5",
  alpha_amount: "0",
  observed_at: "1783600000000",
};

test("GET /api/v1/blocks returns a block feed shaped like the D1 route", async () => {
  mockRows.current = [BLOCK_ROW];
  const res = await req("/api/v1/blocks?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.schema_version).toBe(1);
  expect(body.block_count).toBe(1);
  expect(body.blocks[0].block_number).toBe(8586300);
  expect(typeof body.blocks[0].block_number).toBe("number");
  expect(body.blocks[0].author).toBe("5Author");
  expect(body.next_cursor).toBe("8586300"); // rows.length === limit
});

test("GET /api/v1/blocks applies the same filter set as loadBlocks", async () => {
  mockRows.current = [BLOCK_ROW];
  await req(
    "/api/v1/blocks?author=5A&spec_version=424&block_start=1&block_end=2&from=1&to=2&min_extrinsics=1&min_events=1",
  );
  const text = queryText();
  expect(text).toContain("AND author =");
  expect(text).toContain("AND spec_version =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
  expect(text).toContain("AND observed_at >=");
  expect(text).toContain("AND observed_at <=");
  expect(text).toContain("AND extrinsic_count >=");
  expect(text).toContain("AND event_count >=");
});

test("GET /api/v1/blocks uses a cursor seek instead of OFFSET when cursor is present", async () => {
  mockRows.current = [BLOCK_ROW];
  await req("/api/v1/blocks?cursor=8586300");
  const text = queryText();
  expect(text).toContain("AND block_number <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/blocks/:ref resolves a numeric ref + neighbors", async () => {
  // Queue slot 0 is the unconditional `SET statement_timeout` call every
  // request issues before any route matching runs.
  mockQueue.current = [[], [BLOCK_ROW], [{ prev: 8586299, next: 8586301 }]];
  const res = await req("/api/v1/blocks/8586300");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block.block_number).toBe(8586300);
  expect(body.prev_block_number).toBe(8586299);
  expect(body.next_block_number).toBe(8586301);
});

test("GET /api/v1/blocks/:ref resolves a lowercased hash ref", async () => {
  mockQueue.current = [[], [BLOCK_ROW], [{ prev: null, next: null }]];
  const upperHash = `0x${"ABC".repeat(21)}D`; // 64 hex chars, mixed-case
  const res = await req(`/api/v1/blocks/${upperHash}`);
  expect(res.status).toBe(200);
  expect(sqlCalls.some((c) => c.values.includes(upperHash.toLowerCase()))).toBe(
    true,
  );
});

test("GET /api/v1/blocks/:ref on a malformed ref skips the query entirely (block:null)", async () => {
  const res = await req("/api/v1/blocks/not-a-real-ref");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block).toBeNull();
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/blocks/:ref on an unknown block skips the neighbor query", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/blocks/999999999");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block).toBeNull();
  expect(body.prev_block_number).toBeNull();
  expect(body.next_block_number).toBeNull();
  expect(sqlCalls.length).toBe(2); // SET + the main lookup, no neighbor query
});

test("GET /api/v1/extrinsics returns a feed with call_args parsed from the ::text cast", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req("/api/v1/extrinsics?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic_count).toBe(1);
  const ex = body.extrinsics[0];
  expect(ex.block_number).toBe(8586300);
  expect(ex.success).toBe(true);
  expect(ex.call_args).toEqual({ a: 1 }); // parsed, not the raw string
  expect(queryText()).toContain("call_args::text AS call_args");
});

test("GET /api/v1/extrinsics applies the same filter set as loadExtrinsics", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req(
    "/api/v1/extrinsics?signer=5S&call_module=SubtensorModule&call_function=set_weights&success=true&block=1&block_start=1&block_end=2&from=1&to=2",
  );
  const text = queryText();
  expect(text).toContain("AND block_number =");
  expect(text).toContain("AND signer =");
  expect(text).toContain("AND call_module =");
  expect(text).toContain("AND call_function =");
  expect(text).toContain("AND success =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
  expect(text).toContain("AND observed_at >=");
  expect(text).toContain("AND observed_at <=");
});

test("GET /api/v1/extrinsics with success=false filters correctly, distinct from absent", async () => {
  mockRows.current = [{ ...EXTRINSIC_ROW, success: false }];
  const res = await req("/api/v1/extrinsics?success=false");
  const body = await res.json();
  expect(body.extrinsics[0].success).toBe(false);
  expect(queryText()).toContain("AND success =");
  sqlCalls.length = 0;
  await req("/api/v1/extrinsics");
  expect(queryText()).not.toContain("AND success =");
});

test("GET /api/v1/extrinsics matches call_hash against the cast call_args text", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const hash = `0x${"a".repeat(64)}`;
  await req(`/api/v1/extrinsics?call_hash=${hash}`);
  expect(queryText()).toContain("AND call_args::text LIKE");
  const call = sqlCalls.find((c) => c.text.includes("call_args::text LIKE"));
  expect(call.values).toContain(`%"${hash}"%`);
});

test("GET /api/v1/extrinsics ignores a malformed call_hash instead of erroring", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req("/api/v1/extrinsics?call_hash=not-a-hash");
  expect(res.status).toBe(200);
  expect(queryText()).not.toContain("call_args::text LIKE");
});

test("GET /api/v1/extrinsics uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req("/api/v1/extrinsics?cursor=8586300.2");
  const text = queryText();
  expect(text).toContain("AND (block_number, extrinsic_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/extrinsics/:ref resolves a hash ref with embedded account_events", async () => {
  const eventRow = {
    block_number: "8586300",
    event_index: 0,
    extrinsic_index: 2,
    event_kind: "WeightsSet",
    hotkey: "5Hot",
    coldkey: "5Cold",
    netuid: 4,
    uid: 1,
    amount_tao: "1.5",
    alpha_amount: "0",
    observed_at: "1783600000000",
  };
  // Queue slot 0 is the unconditional `SET statement_timeout` call.
  mockQueue.current = [[], [EXTRINSIC_ROW], [eventRow]];
  const res = await req(`/api/v1/extrinsics/${EXTRINSIC_HASH}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic.extrinsic_hash).toBe(EXTRINSIC_HASH);
  expect(body.events).toHaveLength(1);
  expect(body.events[0].event_kind).toBe("WeightsSet");
});

test("GET /api/v1/extrinsics/:ref resolves a composite block-index ref", async () => {
  mockQueue.current = [[], [EXTRINSIC_ROW], []];
  const res = await req("/api/v1/extrinsics/8586300-2");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic.extrinsic_index).toBe(2);
  expect(body.events).toEqual([]);
});

test("GET /api/v1/extrinsics/:ref on a malformed ref skips the query (extrinsic:null)", async () => {
  const res = await req("/api/v1/extrinsics/not-a-real-ref");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic).toBeNull();
  expect(body.events).toEqual([]);
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/extrinsics/:ref skips the embedded-events query on an unresolved ref", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/extrinsics/0x${"a".repeat(64)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic).toBeNull();
  expect(body.events).toEqual([]);
  expect(sqlCalls.length).toBe(2); // SET + the main lookup, no events query
});

test("GET /api/v1/accounts/:ss58/events returns a feed shaped like the D1 route", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/events?limit=1`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.event_count).toBe(1);
  const ev = body.events[0];
  expect(ev.block_number).toBe(8586300);
  expect(ev.event_kind).toBe("StakeAdded");
  expect(ev.amount_tao).toBe(1.5);
});

test("GET /api/v1/accounts/:ss58/events matches hotkey OR coldkey in one flat WHERE, no INDEXED BY / dedup guard", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(`/api/v1/accounts/${SS58}/events`);
  const text = queryText();
  expect(text).toContain("WHERE (hotkey =");
  expect(text).toContain("OR coldkey =");
  expect(text).not.toContain("INDEXED BY");
  expect(text).not.toContain("UNION");
  expect(text).not.toContain("hotkey <>");
});

test("GET /api/v1/accounts/:ss58/events applies the same filter set as loadAccountEvents", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(
    `/api/v1/accounts/${SS58}/events?kind=StakeAdded&netuid=4&block_start=1&block_end=2`,
  );
  const text = queryText();
  expect(text).toContain("AND event_kind =");
  expect(text).toContain("AND netuid =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
});

test("GET /api/v1/accounts/:ss58/events uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(`/api/v1/accounts/${SS58}/events?cursor=8586300.0`);
  const text = queryText();
  expect(text).toContain("AND (block_number, event_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/events with no matching rows returns a schema-stable empty feed", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${SS58}/events`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.event_count).toBe(0);
  expect(body.events).toEqual([]);
  expect(body.next_cursor).toBeNull();
});

test("POST is rejected with 405", async () => {
  const res = await req("/api/v1/chain-events", { method: "POST" });
  expect(res.status).toBe(405);
});

test("unknown path is 404", async () => {
  const res = await req("/api/v1/nope");
  expect(res.status).toBe(404);
});

test("missing Hyperdrive binding is 503", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/chain-events"),
    {},
    ctx,
  );
  expect(res.status).toBe(503);
});
