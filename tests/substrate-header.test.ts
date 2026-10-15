import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  canonicalRawBlock,
  compactU32,
  substrateHash,
  substrateHeader,
} from "../src/substrate-header.ts";
import { syntheticNode } from "./helpers/raw-capture-fixture.ts";
const authentic = JSON.parse(
  readFileSync(
    new URL("./fixtures/raw-capture/mainnet-9277292.json", import.meta.url),
    "utf8",
  ),
);

test("authentic RPC header hashes to the independently frozen SCALE vector", () => {
  const h = substrateHeader(authentic.block.header);
  assert.equal(h.hash, authentic.provenance.block_hash);
  assert.equal(h.height, 9277292);
  assert.equal(h.parentHash, authentic.block.parent_hash);
  assert.equal(substrateHeader(authentic.parent_header).hash, h.parentHash);
  assert.equal(
    canonicalRawBlock(authentic.block, h.height, h.parentHash),
    h.hash,
  );
});

test.each([
  [0, "00"],
  [63, "fc"],
  [64, "0101"],
  [16383, "fdff"],
  [16384, "02000100"],
  [1073741823, "feffffff"],
  [1073741824, "0300000040"],
  [4294967295, "03ffffffff"],
] as const)("Compact<u32> %i has the SCALE boundary encoding %s", (n, hex) =>
  assert.equal(Buffer.from(compactU32(n)).toString("hex"), hex),
);
test.each([-1, 1.5, NaN, Infinity, 4294967296])(
  "invalid compact block number %s refuses before allocation",
  (n) => assert.throws(() => compactU32(n), /Invalid Substrate block number/),
);
test("hash identity is strict and normalized", () => {
  assert.equal(substrateHash(`0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`);
  for (const value of [null, 1, "0x12", `0x${"gg".repeat(32)}`])
    assert.throws(() => substrateHash(value), /Invalid Substrate hash/);
});
test("malformed header fields and digest budgets refuse", () => {
  const h = authentic.block.header;
  for (const value of [
    null,
    1,
    {},
    { ...h, number: "12" },
    { ...h, number: "0x123456789" },
    { ...h, parentHash: "0x" },
    { ...h, stateRoot: null },
    { ...h, extrinsicsRoot: undefined },
    { ...h, digest: null },
    { ...h, digest: { logs: "bad" } },
    { ...h, digest: { logs: Array(257).fill("0x0000") } },
    { ...h, digest: { logs: ["0x0"] } },
    { ...h, digest: { logs: [null] } },
    { ...h, digest: { logs: [`0x${"00".repeat(1024 * 1024 + 1)}`] } },
  ])
    assert.throws(
      () => substrateHeader(value),
      /Invalid Substrate|digest exceeds budget/,
    );
  assert.equal(substrateHeader({ ...h, digest: { logs: [] } }).height, 9277292);
});
test("canonical rows refuse number/hash/parent mismatch and unavailable bytes", () => {
  const row = authentic.block,
    parent = row.parent_hash;
  for (const value of [
    { ...row, block_number: 1 },
    { ...row, block_hash: `0x${"ff".repeat(32)}` },
    { ...row, parent_hash: `0x${"ff".repeat(32)}` },
    { ...row, extrinsics: null },
    { ...row, extrinsics: [null] },
    { ...row, extrinsics: ["0x0"] },
    { ...row, events: null },
    { ...row, events: "0x" },
    { ...row, events: "0x0" },
  ])
    assert.throws(
      () => canonicalRawBlock(value, row.block_number, parent),
      /canonical block differs/,
    );
  assert.throws(
    () => canonicalRawBlock(row, row.block_number, `0x${"ff".repeat(32)}`),
    /canonical block differs/,
  );
  assert.equal(
    canonicalRawBlock({ ...row, extrinsics: [] }, row.block_number, parent),
    row.block_hash,
  );
  const synthetic = syntheticNode();
  assert.equal(
    substrateHeader(synthetic.headers.get(10)).hash,
    synthetic.hash(10),
  );
});
