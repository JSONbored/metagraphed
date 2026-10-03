import assert from "node:assert/strict";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import metadata14 from "./fixtures/native-metadata-v14.ts";
import metadata15 from "./fixtures/native-metadata-v15.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { runtimeApiId, scaleReadMethods } from "../src/native-runtime-scale.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

// Independent Substrate metadata and codec fixtures, not captured Subtensor
// state. V14's lack of runtime signatures is real; nonce/byte results are
// synthetic. No socket or global fetch is used.
const registry = new TypeRegistry();
const hash = `0x${"33".repeat(32)}`;
const previous = `0x${"22".repeat(32)}`;
const account = `0x${"12".repeat(32)}`;
const nonce = `0x${Buffer.from(registry.createType("u32", 16909060).toU8a()).toString("hex")}`;
const apis = [
  "AccountNonceApi",
  "EthereumRuntimeRPCApi",
  "Core",
  "ContractsApi",
  "ShieldApi",
];
function fixture({
  result = nonce,
  metadata = metadata14,
  advertised = apis,
}: {
  result?: unknown;
  metadata?: string;
  advertised?: string[];
} = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "chain_getFinalizedHead") return hash;
    if (method === "chain_getHeader")
      return { number: params[0] === previous ? "0x1ea" : "0x1f4" };
    if (method === "chain_getBlockHash")
      return params[0] === 0 ? `0x${"44".repeat(32)}` : previous;
    if (method === "state_getRuntimeVersion")
      return {
        specName: "node-subtensor",
        specVersion: 372,
        transactionVersion: 1,
        apis: advertised.map((name) => [runtimeApiId(name), 1]),
      };
    if (method === "state_getStorageHash") return null;
    if (method === "state_getMetadata") return metadata;
    assert.equal(method, "state_call");
    if (params[0] === "Metadata_metadata_at_version") {
      if (metadata === metadata14) throw new Error("V15 metadata not present");
      return metadata;
    }
    return result;
  };
  rpc.batch = (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return {
    rpc,
    calls,
    execution: () =>
      calls.filter(
        (row) =>
          row.method === "state_call" &&
          row.params[0] !== "Metadata_metadata_at_version",
      ),
  };
}
const operation = {
  kind: "runtime_scale",
  api: "AccountNonceApi",
  member: "account_nonce",
  input: registry.createType("AccountId32", account).toHex(),
};

test("V14 runtime reads use reference SCALE bytes, advertise API version and coalesce at one canonical finalized source", async () => {
  assert.equal(runtimeApiId("Core"), "0xdf6acb689907609b");
  for (const metadata of [metadata14, metadata15]) {
    const f = fixture({ metadata });
    const response = await queryNativeRuntime(
      { as_of: previous, operations: [operation, operation] },
      f.rpc,
    );
    assert.equal(response.source.finalized_block_hash, previous);
    assert.equal(response.source.finalized_block, "490");
    assert.equal(
      response.source.metadata_version,
      metadata === metadata14 ? 14 : 15,
    );
    assert.deepEqual(response.types, []);
    assert.deepEqual(response.results[0], response.results[1]);
    assert.equal(response.results[0]!.value, nonce);
    assert.equal(
      registry.createType("u32", Buffer.from(nonce.slice(2), "hex")).toString(),
      "16909060",
    );
    assert.deepEqual(response.results[0]!.contract, {
      encoding: "scale",
      abi: "caller-encoded",
      runtime_api_id: runtimeApiId("AccountNonceApi"),
      runtime_api_version: 1,
    });
    assert.deepEqual(f.execution(), [
      {
        method: "state_call",
        params: ["AccountNonceApi_account_nonce", operation.input, previous],
      },
    ]);
  }
});

test("V14 discovery returns usable audited reads without fabricated type signatures", async () => {
  const f = fixture();
  let offset = 0,
    found = false;
  for (let pages = 0; pages < 8; pages++) {
    const directory = await queryNativeRuntime(
      { as_of: hash, operations: [{ kind: "describe", limit: 64, offset }] },
      f.rpc,
    );
    assert.ok(Array.isArray(directory.results[0]!.value));
    found ||= directory.results[0]!.value.some(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        row.name === "AccountNonceApi",
    );
    const contract = directory.results[0]!.contract;
    assert.ok(
      contract !== null &&
        typeof contract === "object" &&
        !Array.isArray(contract),
    );
    if (contract.next_offset === null) break;
    assert.equal(typeof contract.next_offset, "number");
    offset = Number(contract.next_offset);
  }
  assert.ok(
    found,
    "The advertised read API must appear in the paginated directory",
  );
  const response = await queryNativeRuntime(
    { operations: [{ kind: "describe", api: "AccountNonceApi" }] },
    f.rpc,
  );
  assert.deepEqual(response.results[0]!.value, [
    {
      kind: "runtime_scale",
      api: "AccountNonceApi",
      member: "account_nonce",
      runtime_api_version: 1,
    },
  ]);
  assert.equal(f.execution().length, 0);
  const page = await queryNativeRuntime(
    {
      operations: [
        { kind: "describe", api: "EthereumRuntimeRPCApi", limit: 1 },
      ],
    },
    f.rpc,
  );
  assert.deepEqual(page.results[0]!.contract, { total: 13, next_offset: 1 });
  const empty = await queryNativeRuntime(
    { operations: [{ kind: "describe", api: "AccountNonceApi", offset: 1 }] },
    f.rpc,
  );
  assert.deepEqual(empty.results[0]!.value, []);
  for (const api of ["UnknownApi", "toString"]) {
    await assert.rejects(
      queryNativeRuntime({ operations: [{ kind: "describe", api }] }, f.rpc),
      /Unknown native runtime API/,
    );
  }
});

test("typed requests retain their metadata-only path without validating an unused API list", async () => {
  for (const metadata of [metadata14, metadata15]) {
    const f = fixture({ metadata });
    const rpc: BasketRpc = async (method, params) => {
      const value = await f.rpc(method, params);
      return method === "state_getRuntimeVersion"
        ? {
            specName: "node-subtensor",
            specVersion: 372,
            transactionVersion: 1,
            apis: "invalid unused list",
          }
        : value;
    };
    for (const operation of [
      { kind: "describe", type_id: 0 },
      { kind: "describe", pallet: "System" },
    ]) {
      const response = await queryNativeRuntime(
        { operations: [operation] },
        rpc,
      );
      assert.equal(response.results[0]!.kind, "describe");
    }
    await assert.rejects(queryNativeRuntime({ operations: [operation] }, rpc));
    assert.equal(f.execution().length, 0);
  }
});

test("mixed V15 discovery and SCALE reads share the same advertised API context", async () => {
  const f = fixture({ metadata: metadata15 });
  const response = await queryNativeRuntime(
    { operations: [{ kind: "describe", limit: 64 }, operation] },
    f.rpc,
  );
  assert.equal(response.results[1]!.value, nonce);
  assert.equal(f.execution().length, 1);
  const duplicate = fixture({
    advertised: ["AccountNonceApi", "AccountNonceApi"],
  });
  await assert.rejects(
    queryNativeRuntime({ operations: [operation] }, duplicate.rpc),
    /Duplicate advertised/,
  );
  assert.equal(duplicate.execution().length, 0);
});

test("raw execution never bypasses audited methods or decoded simulation budgets", async () => {
  assert.deepEqual(scaleReadMethods("constructor"), []);
  assert.deepEqual(scaleReadMethods("__proto__"), []);
  assert.equal(scaleReadMethods("BetaBasketRuntimeApi", 1).length, 8);
  assert.equal(scaleReadMethods("BetaBasketRuntimeApi", 2).length, 10);
  assert.equal(scaleReadMethods("BetaBasketRuntimeApi", 3).length, 15);
  assert.equal(scaleReadMethods("BetaBasketRuntimeApi", 4).length, 16);
  assert.equal(scaleReadMethods("BetaBasketRuntimeApi", 5).length, 18);
  assert.ok(
    !scaleReadMethods("SubnetInfoRuntimeApi", 1).includes(
      "get_subnet_hyperparams_v3",
    ),
  );
  assert.ok(
    scaleReadMethods("SubnetInfoRuntimeApi", 2).includes(
      "get_subnet_hyperparams_v3",
    ),
  );
  for (const [api, member] of [
    ["Core", "execute_block"],
    ["SessionKeys", "generate_session_keys"],
    ["GrandpaApi", "submit_report_equivocation_unsigned_extrinsic"],
    ["GenesisBuilder", "build_state"],
    ["EthereumRuntimeRPCApi", "pending_block"],
    ["EthereumRuntimeRPCApi", "call"],
    ["EthereumRuntimeRPCApi", "create"],
    ["ContractsApi", "call"],
    ["ContractsApi", "instantiate"],
    ["ContractsApi", "upload_code"],
    ["UnknownApi", "read"],
    ["AccountNonceApi", "unknown_future_method"],
    ["BetaBasketRuntimeApi", "get_basket_claim_preview"],
    ["SubnetInfoRuntimeApi", "get_subnet_hyperparams_v3"],
  ]) {
    const f = fixture({ advertised: [api!] });
    await assert.rejects(
      queryNativeRuntime(
        { operations: [{ ...operation, api, member }] },
        f.rpc,
      ),
      /not audited/,
    );
    assert.equal(f.execution().length, 0);
  }
  const missing = fixture({ advertised: [] });
  await assert.rejects(
    queryNativeRuntime({ operations: [operation] }, missing.rpc),
    /API is absent/,
  );
  await assert.rejects(
    queryNativeRuntime(
      { operations: [{ kind: "describe", api: "AccountNonceApi" }] },
      missing.rpc,
    ),
    /Unknown native runtime API/,
  );
  assert.equal(missing.execution().length, 0);
  for (const input of [
    "0x0",
    "0xgg",
    "01",
    "0X00",
    "0x" + "00".repeat(16384),
  ]) {
    const f = fixture();
    await assert.rejects(
      queryNativeRuntime({ operations: [{ ...operation, input }] }, f.rpc),
    );
    assert.equal(f.calls.length, 0);
  }
});

test("raw result admission preserves exact bytes, including empty results, and rejects corrupt or over-budget replies", async () => {
  for (const result of ["0x", "0x00ABff", "0x" + "fe".repeat(1024)]) {
    const f = fixture({ result });
    const response = await queryNativeRuntime(
      { operations: [operation] },
      f.rpc,
    );
    assert.equal(response.results[0]!.value, result);
  }
  for (const result of [
    null,
    0,
    {},
    "0x1",
    "0xgg",
    "0X00",
    "0x" + "00".repeat(262145),
  ]) {
    await assert.rejects(
      queryNativeRuntime({ operations: [operation] }, fixture({ result }).rpc),
      /Invalid or oversized SCALE/,
    );
  }
  const result = "0x" + "00".repeat(65536);
  await assert.rejects(
    queryNativeRuntime(
      { operations: Array(8).fill(operation) },
      fixture({ result }).rpc,
    ),
    /response exceeds byte budget/,
  );
});
