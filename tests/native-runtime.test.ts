import assert from "node:assert/strict";
import { test } from "vitest";
import metadata14 from "./fixtures/native-metadata-v14.ts";
import metadata15 from "./fixtures/native-metadata-v15.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { type BasketRpc } from "../src/root-basket-runtime.ts";
import { nativeContractEdgeFixture } from "./fixtures/native-contract-edge.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
} from "../src/native-runtime-metadata.ts";

const hash = `0x${"33".repeat(32)}`,
  genesis = `0x${"44".repeat(32)}`;
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    const key = method === "state_call" ? String(params[0]) : method;
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value;
    }
    switch (key) {
      case "chain_getFinalizedHead":
        return hash;
      case "chain_getHeader":
        return { number: "0x1f4" };
      case "state_getRuntimeVersion":
        return {
          specName: "node-subtensor",
          specVersion: 470,
          transactionVersion: 1,
        };
      case "chain_getBlockHash":
        return params[0] === 0 ? genesis : hash;
      case "Metadata_metadata_at_version":
        return metadata15;
      case "state_getMetadata":
        return metadata14;
      case "state_getStorage":
        return "0xf4010000";
      case "state_getStorageHash":
        return null;
      default:
        throw new Error(`Unexpected fixture call ${key}`);
    }
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return { rpc, calls };
}
test("consensus and EVM reads are usable while mixed API write methods never reach state_call", async () => {
  const pairs = [
    ["AuraApi", "slot_duration", "authorities"],
    ["BabeApi", "current_epoch", "submit_report_equivocation_unsigned_extrinsic"],
    ["GrandpaApi", "current_set_id", "submit_report_equivocation_unsigned_extrinsic"],
    ["SessionKeys", "decode_session_keys", "generate_session_keys"],
    ["GenesisBuilder", "get_preset", "build_state"],
    ["EthereumRuntimeRPCApi", "account_basic", "pending_block"],
    ["ConvertTransactionRuntimeApi", "convert_transaction", "unknown_future_method"],
    ["Metadata", "metadata_versions", "unknown_future_method"],
  ];
  const { wrapped } = nativeContractEdgeFixture(false, pairs.map(([name, read, write]) => ({
    name: name!, docs: [], methods: [read!, write!].map((member) => ({
      name: member, inputs: [{ name: "fixture", type: 0 }], output: 0, docs: [],
    })),
  })));
  const source = fixture({
    Metadata_metadata_at_version: wrapped,
    ...Object.fromEntries(pairs.map(([api, member]) => [`${api}_${member}`, "0x2a"])),
  });
  for (const [api, read, write] of pairs) {
    const discovery = await queryNativeRuntime({ operations: [{ kind: "describe", api }] }, source.rpc);
    assert.deepEqual((discovery.results[0]!.value as { member: string }[]).map((row) => row.member), [read]);
    const result = await queryNativeRuntime({ operations: [{ kind: "runtime", api, member: read, args: [7] }] }, source.rpc);
    assert.equal(result.results[0]!.value, "42");
    assert.ok(source.calls.some((call) => call.method === "state_call" && call.params[0] === `${api}_${read}` && call.params[1] === "0x07" && call.params[2] === hash));
    await assert.rejects(queryNativeRuntime({ operations: [{ kind: "runtime", api, member: write, args: [7] }] }, source.rpc), /audited read/);
    assert.ok(!source.calls.some((call) => call.method === "state_call" && call.params[0] === `${api}_${write}`));
  }
});
test("portable API discovery, bit and tuple contracts and empty pallets remain usable", async () => {
  const { wrapped } = nativeContractEdgeFixture();
  const source = fixture({
    Metadata_metadata_at_version: wrapped,
    ShieldApi_is_shielded_using_current_key: "0x01",
    ContractsApi_get_storage: "0x02",
  });
  const out = await queryNativeRuntime(
    {
      operations: [
        { kind: "describe", limit: 64 },
        { kind: "describe", pallet: "NoCalls" },
        { kind: "describe", pallet: "Fixture" },
        { kind: "describe", api: "SwapRuntimeApi" },
        { kind: "describe", type_id: 4 },
        { kind: "describe", type_id: 5 },
        {
          kind: "runtime",
          api: "ShieldApi",
          member: "is_shielded_using_current_key",
        },
        { kind: "runtime", api: "ContractsApi", member: "get_storage" },
      ],
    },
    source.rpc,
  );
  assert.deepEqual(out.results[1]!.value, []);
  assert.ok(out.types.some((row) => row.definition.kind === "bits"));
  assert.ok(out.types.some((row) => row.definition.kind === "tuple"));
  assert.equal(out.results[6]!.value, "1");
  assert.equal(out.results[7]!.value, "2");
  await assert.rejects(
    queryNativeRuntime(
      { operations: [{ kind: "prepare", pallet: "NoCalls", member: "none" }] },
      source.rpc,
    ),
    /extrinsic/,
  );
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [{ kind: "entries", pallet: "Fixture", member: "Amounts" }],
      },
      source.rpc,
    ),
    /storage map/,
  );
});
test("aggregate native inputs and expanded result context have independent byte budgets", async () => {
  const { wrapped, registry } = nativeContractEdgeFixture();
  for (const operation of [
    {
      kind: "runtime",
      api: "SwapRuntimeApi",
      member: "fixture",
      args: [Array(8191).fill(1), 1],
    },
    {
      kind: "prepare",
      pallet: "Fixture",
      member: "large_call",
      args: [Array(8191).fill(1), 1],
    },
  ]) {
    const source = fixture({ Metadata_metadata_at_version: wrapped });
    await assert.rejects(
      queryNativeRuntime({ operations: [operation] }, source.rpc),
      /input exceeds|call exceeds/,
    );
    assert.equal(
      source.calls.filter((row) => row.method === "state_call").length,
      1,
    );
  }
  const source = fixture({
    Metadata_metadata_at_version: wrapped,
    state_getStorage: `0x${Buffer.concat([registry.createType("Compact<u32>", 6000).toU8a(), Buffer.alloc(32 * 6000, 255)]).toString("hex")}`,
  });
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          { kind: "storage", pallet: "Fixture", member: "Amounts" },
          { kind: "storage", pallet: "Fixture", member: "Amounts" },
        ],
      },
      source.rpc,
    ),
    /response exceeds/,
  );
});
test("native reads, constants and unsigned calls use one finalized contract and coalesce repeated work", async () => {
  const source = fixture();
  const result = await queryNativeRuntime(
    {
      network: "finney",
      operations: [
        { kind: "storage", pallet: "System", member: "Number" },
        { kind: "storage", pallet: "System", member: "Number" },
        { kind: "constant", pallet: "System", member: "BlockHashCount" },
        {
          kind: "prepare",
          pallet: "System",
          member: "remark",
          args: ["0x010203"],
        },
        { kind: "describe", pallet: "System", limit: 1 },
      ],
    },
    source.rpc,
  );
  assert.equal(result.source.finalized_block, "500");
  assert.equal(result.source.metadata_version, 15);
  assert.deepEqual(result.results[0], result.results[1]);
  assert.equal(result.results[0]!.value, "500");
  assert.equal(result.results[0]!.is_default, false);
  assert.equal(result.results[3]!.call_data, "0x00000c010203");
  assert.equal(
    new Set(result.types.map((type) => type.id)).size,
    result.types.length,
  );
  assert.equal(
    source.calls.filter((call) => call.method === "state_getStorage").length,
    1,
  );
  assert.ok(
    source.calls
      .filter((call) =>
        ["state_getStorage", "state_call"].includes(call.method),
      )
      .every((call) => call.params.at(-1) === hash),
  );
  assert.ok(!source.calls.some((call) => call.method.startsWith("author_")));
});
test("typed runtime reads encode the declared input and retain exact return values", async () => {
  const source = fixture({ AccountNonceApi_account_nonce: "0x05000000" });
  const account = `0x${"12".repeat(32)}`;
  const result = await queryNativeRuntime(
    {
      operations: [
        {
          kind: "runtime",
          api: "AccountNonceApi",
          member: "account_nonce",
          args: [account],
        },
        {
          kind: "runtime",
          api: "AccountNonceApi",
          member: "account_nonce",
          args: [account],
        },
        { kind: "describe", api: "AccountNonceApi" },
      ],
    },
    source.rpc,
  );
  assert.equal(result.results[0]!.value, "5");
  assert.deepEqual(result.results[0], result.results[1]);
  assert.deepEqual(
    source.calls.filter(
      (call) => call.params[0] === "AccountNonceApi_account_nonce",
    ),
    [
      {
        method: "state_call",
        params: ["AccountNonceApi_account_nonce", account, hash],
      },
    ],
  );
  assert.ok(
    result.types.some(
      (type) =>
        type.definition.kind === "array" && type.definition.length === 32,
    ),
  );
});
test("sharing one finalized contract saves the actual repeated result registry bytes", async () => {
  const operation = {
    kind: "storage" as const,
    pallet: "System",
    member: "Number",
    args: [],
  };
  const source = fixture();
  const batched = await queryNativeRuntime(
    { operations: Array(16).fill(operation) },
    source.rpc,
  );
  const single = await queryNativeRuntime(
    { operations: [operation] },
    fixture().rpc,
  );
  assert.equal(
    JSON.stringify(batched.results),
    JSON.stringify(Array(16).fill(single.results[0])),
  );
  const sharedBytes = Buffer.byteLength(JSON.stringify(batched.types));
  const repeatedBytes = 16 * Buffer.byteLength(JSON.stringify(single.types));
  console.log(
    "NATIVE_RUNTIME_SHARED_CONTRACT_FIXTURE",
    JSON.stringify({
      operations: 16,
      shared_type_bytes: sharedBytes,
      repeat_type_bytes: repeatedBytes,
      saved_type_bytes: repeatedBytes - sharedBytes,
      duplicate_storage_reads_removed: 15,
      fixture: true,
      production: false,
    }),
  );
  assert.equal(
    source.calls.filter((call) => call.method === "state_getStorage").length,
    1,
  );
  assert.equal(repeatedBytes, 16 * sharedBytes);
});
test("metadata declarations retain optional absence and exact declared defaults", async () => {
  const meta = decodeNativeMetadata(unwrapNativeMetadata(metadata15)!);
  const pallet = meta.pallets.find((row) =>
    row.storage.some((item) => item.optional && item.key === null),
  )!;
  const optional = pallet.storage.find(
    (item) => item.optional && item.key === null,
  )!;
  // System.BlockHash has a u32 key; this known map makes absence/defaults independent of the fixture's other optional maps.
  const source = fixture({ state_getStorage: null });
  const out = await queryNativeRuntime(
    {
      operations: [
        { kind: "storage", pallet: "System", member: "BlockHash", args: [500] },
      ],
    },
    source.rpc,
  );
  assert.equal(out.results[0]!.is_default, true);
  assert.equal(out.results[0]!.value, `0x${"00".repeat(32)}`);
  const absent = await queryNativeRuntime(
    {
      operations: [
        { kind: "storage", pallet: pallet.name, member: optional.name },
      ],
    },
    source.rpc,
  );
  assert.equal(absent.results[0]!.is_default, false);
  assert.equal(absent.results[0]!.value, null);
});
test("V14 fallback and paginated native discovery preserve older runtime contracts", async () => {
  const source = fixture({ Metadata_metadata_at_version: "0x00" });
  const result = await queryNativeRuntime(
    {
      operations: [
        { kind: "describe", limit: 1 },
        { kind: "describe", api: "Core", limit: 1 },
      ],
    },
    source.rpc,
  ).catch((error) => error);
  assert.ok(result instanceof Error); // V14 does not advertise a runtime API signature; never guess its types.
  const out = await queryNativeRuntime(
    { operations: [{ kind: "describe", limit: 1 }] },
    source.rpc,
  );
  assert.equal(out.source.metadata_version, 14);
  assert.equal(out.results[0]!.value instanceof Array, true);
  assert.deepEqual(out.types, []);
  const failed = fixture({
    Metadata_metadata_at_version: new Error("API version absent"),
  });
  assert.equal(
    (
      await queryNativeRuntime(
        { operations: [{ kind: "describe", limit: 64 }] },
        failed.rpc,
      )
    ).source.metadata_version,
    14,
  );
});
test("every plan validates before any native state read; node execution and keystore APIs are denied", async () => {
  for (const operation of [
    { kind: "storage", pallet: "Unknown", member: "Number" },
    { kind: "storage", pallet: "System", member: "Unknown" },
    { kind: "storage", pallet: "System", member: "Number", args: [1] },
    { kind: "constant", pallet: "System", member: "Unknown" },
    { kind: "prepare", pallet: "System", member: "Unknown" },
    { kind: "prepare", pallet: "System", member: "remark", args: [] },
    { kind: "runtime", api: "SessionKeys", member: "generate_session_keys" },
    { kind: "runtime", api: "Core", member: "execute_block" },
    { kind: "runtime", api: "StakeInfoRuntimeApi", member: "Unknown" },
    { kind: "runtime", api: "Core", member: "version", args: [1] },
    { kind: "describe", pallet: "Unknown" },
    { kind: "describe", api: "Unknown" },
    { kind: "describe", pallet: "System", api: "Core" },
    { kind: "describe", type_id: 16383 },
  ]) {
    const source = fixture();
    await assert.rejects(
      queryNativeRuntime(
        {
          operations: [
            { kind: "storage", pallet: "System", member: "Number" },
            operation,
          ],
        },
        source.rpc,
      ),
    );
    assert.ok(!source.calls.some((call) => call.method === "state_getStorage"));
    assert.equal(
      source.calls.filter((call) => call.method === "state_call").length,
      1,
    );
  }
});
test("only canonical finalized history is read and malformed source data declines", async () => {
  const history = `0x${"55".repeat(32)}`;
  const good = fixture({ chain_getBlockHash: history });
  const out = await queryNativeRuntime(
    { as_of: history, operations: [{ kind: "describe", api: "Core" }] },
    good.rpc,
  );
  assert.equal(out.source.finalized_block_hash, history);
  for (const overrides of [
    { chain_getBlockHash: hash },
    { chain_getHeader: { number: "0x10000000000000000" } },
    {
      state_getRuntimeVersion: {
        specName: "other",
        specVersion: 470,
        transactionVersion: 1,
      },
    },
    { Metadata_metadata_at_version: "0x00", state_getMetadata: "0x00" },
    { state_getStorage: "0xf401000000" },
    { state_getStorage: "0x00" },
  ])
    await assert.rejects(
      queryNativeRuntime(
        {
          as_of: history,
          operations: [{ kind: "storage", pallet: "System", member: "Number" }],
        },
        fixture(overrides).rpc,
      ),
    );
  const source = fixture();
  await assert.rejects(queryNativeRuntime({ operations: [] }, source.rpc));
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          {
            kind: "prepare",
            pallet: "System",
            member: "remark",
            args: ["0x" + "00".repeat(32768)],
          },
        ],
      },
      source.rpc,
    ),
  );
  assert.equal(source.calls.length, 0);
});
