import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadBlockEvents,
  loadBlockExtrinsics,
  resolveBlockNumber,
} from "../src/block-subresources.mjs";

function d1With(fixtures = {}, capture = []) {
  return async (sql, params) => {
    capture.push({ sql, params });
    if (/FROM blocks WHERE block_hash/.test(sql))
      return fixtures.blockByHash ?? [];
    if (/FROM blocks WHERE block_number/.test(sql))
      return fixtures.blockByNumber ?? [];
    if (/FROM extrinsics WHERE block_number/.test(sql))
      return fixtures.extrinsics ?? [];
    if (/FROM account_events WHERE block_number/.test(sql))
      return fixtures.events ?? [];
    return [];
  };
}

const BLOCK = { block_number: 4_200_000 };
const EXTRINSIC = {
  block_number: 4_200_000,
  extrinsic_index: 1,
  extrinsic_hash: "0x" + "c".repeat(64),
  signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  call_module: "SubtensorModule",
  call_function: "set_weights",
  call_args: null,
  success: 1,
  fee_tao: 0.0005,
  tip_tao: null,
  observed_at: 1_750_009_000_000,
};
const EVENT = {
  block_number: 4_200_000,
  event_index: 0,
  event_kind: "WeightsSet",
  hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  coldkey: null,
  netuid: 7,
  uid: 3,
  amount_tao: null,
  observed_at: 1_750_009_000_000,
};

describe("resolveBlockNumber", () => {
  test("resolves a numeric block_number ref", async () => {
    const capture = [];
    const d1 = d1With({ blockByNumber: [BLOCK] }, capture);
    const n = await resolveBlockNumber(d1, "4200000");
    assert.equal(n, 4_200_000);
    assert.equal(capture.length, 1);
    assert.match(capture[0].sql, /block_number = \?/);
    assert.deepEqual(capture[0].params, [4_200_000]);
  });

  test("resolves a 0x hash ref (lowercased bind param)", async () => {
    const hash = "0x" + "A".repeat(64);
    const capture = [];
    const d1 = d1With({ blockByHash: [BLOCK] }, capture);
    const n = await resolveBlockNumber(d1, hash);
    assert.equal(n, 4_200_000);
    assert.match(capture[0].sql, /block_hash = \?/);
    assert.equal(capture[0].params[0], hash.toLowerCase());
  });

  test("returns null for a malformed ref without querying D1", async () => {
    const capture = [];
    const d1 = d1With({}, capture);
    const n = await resolveBlockNumber(d1, "not-a-block");
    assert.equal(n, null);
    assert.equal(capture.length, 0);
  });

  test("returns null when the block row is missing", async () => {
    const d1 = d1With({ blockByNumber: [] });
    const n = await resolveBlockNumber(d1, "9999999");
    assert.equal(n, null);
  });
});

describe("loadBlockExtrinsics", () => {
  test("returns extrinsics in block read order", async () => {
    const capture = [];
    const d1 = d1With(
      { blockByNumber: [BLOCK], extrinsics: [EXTRINSIC] },
      capture,
    );
    const { data } = await loadBlockExtrinsics(d1, "4200000");
    assert.equal(data.ref, "4200000");
    assert.equal(data.block_number, 4_200_000);
    assert.equal(data.extrinsic_count, 1);
    assert.equal(data.extrinsics[0].call_function, "set_weights");
    const q = capture.find((c) => /FROM extrinsics/.test(c.sql));
    assert.ok(/ORDER BY extrinsic_index ASC/.test(q.sql));
    assert.deepEqual(q.params.slice(0, 3), [4_200_000, 50, 0]);
  });

  test("cold / unknown ref yields schema-stable empty payload", async () => {
    const capture = [];
    const d1 = d1With({}, capture);
    const { data } = await loadBlockExtrinsics(d1, "9999999");
    assert.equal(data.block_number, null);
    assert.equal(data.extrinsic_count, 0);
    assert.deepEqual(data.extrinsics, []);
    assert.equal(
      capture.some((c) => /FROM extrinsics/.test(c.sql)),
      false,
    );
  });

  test("clamps limit and offset for pagination", async () => {
    const capture = [];
    const d1 = d1With({ blockByNumber: [BLOCK], extrinsics: [] }, capture);
    await loadBlockExtrinsics(d1, "4200000", { limit: 500, offset: -3 });
    const q = capture.find((c) => /FROM extrinsics/.test(c.sql));
    assert.deepEqual(q.params.slice(1), [100, 0]);
  });
});

describe("loadBlockEvents", () => {
  test("returns events in block read order", async () => {
    const capture = [];
    const d1 = d1With({ blockByNumber: [BLOCK], events: [EVENT] }, capture);
    const { data } = await loadBlockEvents(d1, "4200000");
    assert.equal(data.ref, "4200000");
    assert.equal(data.block_number, 4_200_000);
    assert.equal(data.event_count, 1);
    assert.equal(data.events[0].event_kind, "WeightsSet");
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    assert.ok(/ORDER BY event_index ASC/.test(q.sql));
    assert.deepEqual(q.params.slice(0, 3), [4_200_000, 100, 0]);
  });

  test("cold / unknown ref yields schema-stable empty payload", async () => {
    const capture = [];
    const d1 = d1With({}, capture);
    const { data } = await loadBlockEvents(d1, "not-a-block");
    assert.equal(data.block_number, null);
    assert.deepEqual(data.events, []);
    assert.equal(
      capture.some((c) => /FROM account_events/.test(c.sql)),
      false,
    );
  });

  test("clamps feed pagination limit", async () => {
    const capture = [];
    const d1 = d1With({ blockByNumber: [BLOCK], events: [] }, capture);
    await loadBlockEvents(d1, "4200000", { limit: 9999, offset: 0 });
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    assert.equal(q.params[1], 1000);
  });
});
