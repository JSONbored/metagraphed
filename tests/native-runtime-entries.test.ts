import assert from "node:assert/strict";
import { test } from "vitest";
import { bittensorNativeFixture } from "./fixtures/native-bittensor.ts";
import { decodeNativeMetadata } from "../src/native-runtime-metadata.ts";
import { nativeHex, nativeStorageKey } from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const hash = `0x${"33".repeat(32)}`;
function fixture(pageOverride?: unknown, valueOverride?: unknown) {
  const { metadata: bare, wrapped, registry } = bittensorNativeFixture();
  const metadata = decodeNativeMetadata(bare),
    pallet = metadata.pallets[0]!;
  const item = pallet.storage.find((row) => row.name === "MinerCollateral")!;
  const value = {
    locked: "9007199254740993",
    drain_ratio: "18446744073709551616",
    min_locked: "1",
    earned: "5",
  };
  const keys = ["11", "22", "33"]
    .map((account) =>
      nativeStorageKey(metadata, pallet.prefix, item, [
        19,
        `0x${account.repeat(32)}`,
        `0x${"44".repeat(32)}`,
      ]),
    )
    .sort();
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "chain_getFinalizedHead":
        return hash;
      case "chain_getBlockHash":
        return `0x${"44".repeat(32)}`;
      case "chain_getHeader":
        return { number: "0x1f4" };
      case "state_getRuntimeVersion":
        return {
          specName: "node-subtensor",
          specVersion: 470,
          transactionVersion: 1,
        };
      case "state_getStorageHash":
        return null;
      case "state_call":
        return wrapped;
      case "state_getKeysPaged":
        return pageOverride !== undefined
          ? pageOverride
          : keys
              .filter((key) => key > String(params[2] ?? ""))
              .slice(0, Number(params[1]));
      case "state_getStorage":
        return valueOverride === undefined
          ? nativeHex(
              registry.createType("MinerCollateralState", value).toU8a(),
            )
          : valueOverride;
      default:
        throw new Error("Unexpected entries fixture call");
    }
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return { rpc, calls, keys, value };
}
const operation = {
  kind: "entries",
  pallet: "SubtensorModule",
  member: "MinerCollateral",
  args: [19],
  limit: 2,
};
test("v470 NMap entries expose typed reversible keys and exact values with a finalized cursor", async () => {
  const source = fixture();
  const out = await queryNativeRuntime(
    { operations: [operation, operation] },
    source.rpc,
  );
  const rows = out.results[0]!.value as {
    storage_key: string;
    keys: { value: string }[];
    value: unknown;
  }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(out.results[0], out.results[1]);
  assert.deepEqual(rows[0]!.value, source.value);
  assert.equal(rows[0]!.keys[0]!.value, "19");
  assert.match(rows[0]!.keys[1]!.value, /^0x(?:11|22|33){32}$/);
  assert.equal(rows[0]!.keys[2]!.value, `0x${"44".repeat(32)}`);
  assert.equal(
    source.calls.filter((row) => row.method === "state_getKeysPaged").length,
    1,
  );
  assert.equal(
    source.calls.filter((row) => row.method === "state_getStorage").length,
    2,
  );
  const next = (out.results[0]!.contract as { next_cursor: string })
    .next_cursor;
  assert.equal(next, source.keys[1]);
  const final = await queryNativeRuntime(
    { as_of: hash, operations: [{ ...operation, cursor: next }] },
    source.rpc,
  );
  assert.equal((final.results[0]!.value as unknown[]).length, 1);
  assert.equal(
    (final.results[0]!.contract as { next_cursor: null }).next_cursor,
    null,
  );
  assert.ok(
    source.calls
      .filter((row) =>
        ["state_getKeysPaged", "state_getStorage"].includes(row.method),
      )
      .every((row) => row.params.at(-1) === hash),
  );
});
test("entry values reuse an already requested storage read without sharing public objects", async () => {
  const source = fixture();
  const hotkey = source.keys[0]!.includes("11".repeat(32))
    ? "11"
    : source.keys[0]!.includes("22".repeat(32))
      ? "22"
      : "33";
  const out = await queryNativeRuntime(
    {
      operations: [
        { ...operation, limit: 1 },
        {
          kind: "storage",
          pallet: operation.pallet,
          member: operation.member,
          args: [19, `0x${hotkey.repeat(32)}`, `0x${"44".repeat(32)}`],
        },
      ],
    },
    source.rpc,
  );
  const entry = (out.results[0]!.value as { value: unknown }[])[0]!;
  assert.deepEqual(entry.value, out.results[1]!.value);
  assert.notEqual(entry.value, out.results[1]!.value);
  assert.deepEqual(out.results[1]!.value, source.value);
  const reads = source.calls.filter((row) => row.method === "state_getStorage");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]!.params, [source.keys[0], hash]);
});
test("empty and fully qualified map prefixes produce bounded records", async () => {
  const empty = await queryNativeRuntime(
    { operations: [operation] },
    fixture([]).rpc,
  );
  assert.deepEqual(empty.results[0]!.value, []);
  const source = fixture();
  const full = await queryNativeRuntime(
    {
      operations: [
        {
          ...operation,
          args: [19, `0x${"11".repeat(32)}`, `0x${"44".repeat(32)}`],
        },
      ],
    },
    fixture([source.keys.find((key) => key.includes("11".repeat(32)))!]).rpc,
  );
  assert.equal((full.results[0]!.value as unknown[]).length, 1);
});
test("entry budgets and unsafe continuation requests fail before chain access", async () => {
  for (const request of [
    {
      operations: [operation, operation, operation].map((op) => ({
        ...op,
        limit: 32,
      })),
    },
    { operations: [{ ...operation, cursor: `0x${"00".repeat(32)}` }] },
  ]) {
    const source = fixture();
    await assert.rejects(
      queryNativeRuntime(request, source.rpc),
      /budget|as_of/,
    );
    assert.equal(source.calls.length, 0);
  }
  const source = fixture();
  await assert.rejects(
    queryNativeRuntime(
      { as_of: hash, operations: [{ ...operation, cursor: "0x00" }] },
      source.rpc,
    ),
    /cursor/,
  );
  assert.ok(!source.calls.some((row) => row.method === "state_getKeysPaged"));
});
test("malformed, unordered and inconsistent entries cannot masquerade as valid state", async () => {
  const { keys } = fixture();
  for (const page of [
    null,
    {},
    [keys[1], keys[0]],
    [keys[0], keys[0]],
    ["0x00"],
    [keys[0] + "00"],
    Array(4).fill(keys[0]),
  ]) {
    await assert.rejects(
      queryNativeRuntime({ operations: [operation] }, fixture(page).rpc),
      /entries|Trailing/,
    );
  }
  const forged =
    keys[0]!.slice(0, 70) +
    (keys[0]!.slice(70, 72) === "00" ? "ff" : "00") +
    keys[0]!.slice(72);
  await assert.rejects(
    queryNativeRuntime({ operations: [operation] }, fixture([forged]).rpc),
    /digest/,
  );
  await assert.rejects(
    queryNativeRuntime(
      { operations: [operation] },
      fixture([keys[0]], null).rpc,
    ),
    /absent/,
  );
});
