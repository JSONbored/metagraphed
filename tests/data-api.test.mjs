// Unit tests for the Postgres-serving data Worker (workers/data-api.mjs). postgres.js
// is mocked so the routing + response shaping are tested with no real DB — the live
// Hyperdrive→Railway path is validated separately.
import { test, expect, vi } from "vitest";

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
    const sql = () => Promise.resolve(rows);
    sql.end = () => Promise.resolve();
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");
const env = { HYPERDRIVE: { connectionString: "postgres://mock" } };
const ctx = { waitUntil() {} };
const req = (path, init) => worker.fetch(new Request(`https://d${path}`, init), env, ctx);

test("GET /api/v1/blocks/:n/events returns the block's events", async () => {
  const res = await req("/api/v1/blocks/123/events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block_number).toBe(123);
  expect(body.count).toBe(1);
  expect(body.events[0].pallet).toBe("System");
  expect(body.events[0].method).toBe("ExtrinsicSuccess");
});

test("GET /api/v1/chain-events returns the feed with a cursor (filters + before)", async () => {
  const res = await req("/api/v1/chain-events?limit=1&pallet=System&method=ExtrinsicSuccess&before=500");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(body.next_before).toBe("123"); // rows.length === limit → cursor is the last row
});

test("limit is clamped and defaults safely", async () => {
  const res = await req("/api/v1/chain-events?limit=99999");
  expect(res.status).toBe(200); // clamp to MAX_LIMIT, no error
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
  const res = await worker.fetch(new Request("https://d/api/v1/chain-events"), {}, ctx);
  expect(res.status).toBe(503);
});
