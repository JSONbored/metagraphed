// Unit tests for the Postgres-serving data Worker (workers/data-api.mjs). postgres.js
// is mocked so the routing + response shaping are tested with no real DB — the live
// Hyperdrive→Railway path is validated separately.
import { beforeEach, test, expect, vi } from "vitest";

const sqlCalls = vi.hoisted(() => []);

vi.mock("postgres", () => ({
  default: () => {
    const rows = [
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
    // Every tagged-template call (top-level query OR nested fragment) resolves to rows;
    // the handler awaits the outer query and ignores interpolated fragment values.
    const sql = (strings, ...values) => {
      sqlCalls.push({ text: Array.from(strings).join("?"), values });
      return Promise.resolve(rows);
    };
    sql.end = () => Promise.resolve();
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

test("GET /api/v1/chain-events returns the feed with a cursor (filters + before)", async () => {
  const res = await req(
    "/api/v1/chain-events?limit=1&pallet=System&method=ExtrinsicSuccess&before=500",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(body.next_before).toBe(123); // rows.length === limit → cursor is the last row
  // BIGINT columns are coerced from postgres.js strings to numbers (D1-route parity).
  expect(body.events[0].block_number).toBe(123);
  expect(typeof body.events[0].block_number).toBe("number");
  expect(body.events[0].observed_at).toBe(100);
  expect(typeof body.events[0].observed_at).toBe("number");
});

test("limit is clamped and defaults safely", async () => {
  const res = await req("/api/v1/chain-events?limit=99999");
  expect(res.status).toBe(200); // clamp to MAX_LIMIT, no error
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
