import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "vitest";
import { loadNativeContract } from "../src/native-runtime-contract.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import metadata15 from "./fixtures/native-metadata-v15.ts";
import metadata14 from "./fixtures/native-metadata-v14.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";
import { nativeContractEdgeFixture } from "./fixtures/native-contract-edge.ts";
beforeEach(() => resetModuleState());
const genesis = `0x${"11".repeat(32)}`,
  hash = `0x${"33".repeat(32)}`;
function fixture(code: unknown = `0x${"22".repeat(32)}`) {
  const calls: { method: string; params: unknown[] }[] = [];
  const read: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "chain_getFinalizedHead":
        return hash;
      case "chain_getBlockHash":
        return genesis;
      case "chain_getHeader":
        return { number: "0x1f4" };
      case "state_getRuntimeVersion":
        return {
          specName: "node-subtensor",
          specVersion: 470,
          transactionVersion: 1,
        };
      case "state_getStorageHash":
        if (code instanceof Error) throw code;
        return code;
      case "state_call":
        return metadata15;
      case "state_getMetadata":
        return metadata14;
      case "state_getStorage":
        return "0xf4010000";
      default:
        throw new Error("Unexpected fixture call");
    }
  };
  return { read, calls };
}
test("warm native requests reuse only their code-bound contract and preserve response bytes", async () => {
  const source = fixture();
  const request = {
    operations: [{ kind: "storage", pallet: "System", member: "Number" }],
  };
  const cold = await queryNativeRuntime(request, source.read);
  const warm = await queryNativeRuntime(request, source.read);
  assert.equal(JSON.stringify(cold), JSON.stringify(warm));
  assert.equal(
    source.calls.filter((call) => call.method === "state_getStorage").length,
    2,
  );
  assert.equal(
    source.calls.filter((call) => call.method === "state_getStorageHash")
      .length,
    2,
  );
  assert.equal(
    source.calls.filter((call) => call.method === "state_call").length,
    1,
  );
  const expected = `0x${createHash("sha256")
    .update(Buffer.from(unwrapNativeMetadata(metadata15)!.slice(2), "hex"))
    .digest("hex")}`;
  assert.equal(warm.source.metadata_sha256, expected);
  assert.equal(warm.source.runtime_code_hash, `0x${"22".repeat(32)}`);
  console.log(
    "NATIVE_RUNTIME_METADATA_REUSE_FIXTURE",
    JSON.stringify({
      metadata_rpc_reads_removed: 1,
      metadata_decodes_removed: 1,
      metadata_wire_hex_bytes_removed: Buffer.byteLength(metadata15),
      additional_code_identity_hex_bytes: 66,
      fixture: true,
      production: false,
    }),
  );
});
test("large portable projections remain readable but cannot displace bounded cache entries", async () => {
  const { wrapped } = nativeContractEdgeFixture(true);
  const source = fixture();
  const read: BasketRpc = (method, params) =>
    method === "state_call"
      ? Promise.resolve(wrapped)
      : source.read(method, params);
  const a = await loadNativeContract(read, hash, genesis, 470, 1);
  const b = await loadNativeContract(read, hash, genesis, 470, 1);
  assert.notEqual(a.metadata, b.metadata);
  assert.equal(a.metadata.types.size, 19);
});
test("metadata negotiation failures fall back to a bounded older contract that can be reused", async () => {
  const source = fixture();
  let negotiated = 0;
  const read: BasketRpc = (method, params) => {
    if (method === "state_call") {
      negotiated++;
      return Promise.reject(new Error("method unavailable"));
    }
    return source.read(method, params);
  };
  const a = await loadNativeContract(read, hash, genesis, 470, 1);
  const b = await loadNativeContract(read, hash, genesis, 470, 1);
  assert.equal(a.metadata.version, 14);
  assert.equal(a.metadata, b.metadata);
  assert.equal(negotiated, 1);
});
test("different finalized blocks can share code; runtime code, genesis and versions cannot cross cache keys", async () => {
  const source = fixture();
  const first = await loadNativeContract(source.read, hash, genesis, 470, 1);
  const otherBlock = `0x${"44".repeat(32)}`;
  assert.equal(
    (await loadNativeContract(source.read, otherBlock, genesis, 470, 1))
      .metadata,
    first.metadata,
  );
  assert.deepEqual(source.calls.at(-1), {
    method: "state_getStorageHash",
    params: ["0x3a636f6465", otherBlock],
  });
  const chain = await loadNativeContract(source.read, hash, otherBlock, 470, 1);
  assert.notEqual(chain.metadata, first.metadata);
  const spec = await loadNativeContract(source.read, hash, otherBlock, 469, 1);
  assert.notEqual(spec.metadata, chain.metadata);
  const transaction = await loadNativeContract(
    source.read,
    hash,
    otherBlock,
    469,
    2,
  );
  assert.notEqual(transaction.metadata, spec.metadata);
  const upgraded = fixture(`0x${"55".repeat(32)}`);
  assert.notEqual(
    (await loadNativeContract(upgraded.read, hash, otherBlock, 469, 2))
      .metadata,
    transaction.metadata,
  );
});
test("failed or absent code identities still read fully and never reuse an unbound contract", async () => {
  for (const identity of [null, "0x00", new Error("Method unavailable")]) {
    const source = fixture(identity);
    const a = await loadNativeContract(source.read, hash, genesis, 470, 1);
    const b = await loadNativeContract(source.read, hash, genesis, 470, 1);
    assert.equal(a.codeHash, null);
    assert.notEqual(a.metadata, b.metadata);
    assert.equal(
      source.calls.filter((call) => call.method === "state_call").length,
      2,
    );
  }
});
test("the two-entry cache evicts the least recently used contract and failures are not retained", async () => {
  const a = fixture(`0x${"aa".repeat(32)}`),
    b = fixture(`0x${"bb".repeat(32)}`),
    c = fixture(`0x${"cc".repeat(32)}`);
  for (const source of [a, b, a, c, a, b])
    await loadNativeContract(source.read, hash, genesis, 470, 1);
  assert.equal(
    a.calls.filter((call) => call.method === "state_call").length,
    1,
  );
  assert.equal(
    b.calls.filter((call) => call.method === "state_call").length,
    2,
  );
  let broken = true;
  const read: BasketRpc = async (method, params) =>
    method === "state_call" && broken
      ? "0x010400"
      : method === "state_getMetadata" && broken
        ? "0x00"
        : a.read(method, params);
  resetModuleState();
  await assert.rejects(loadNativeContract(read, hash, genesis, 470, 1));
  broken = false;
  assert.equal(
    (await loadNativeContract(read, hash, genesis, 470, 1)).metadata.version,
    15,
  );
});

test("typed requests recover V15 signatures after a provider's earlier V14 fallback without refetching V14", async () => {
  const source = fixture();
  let available = false;
  let negotiations = 0;
  const read: BasketRpc = (method, params) => {
    if (
      method === "state_call" &&
      params[0] === "Metadata_metadata_at_version"
    ) {
      negotiations++;
      if (!available) return Promise.resolve("0x00");
    }
    if (
      method === "state_call" &&
      params[0] === "AccountNonceApi_account_nonce"
    )
      return Promise.resolve("0x05000000");
    return source.read(method, params);
  };
  const storage = {
    operations: [{ kind: "storage", pallet: "System", member: "Number" }],
  };
  const cold = await queryNativeRuntime(storage, read);
  const warm = await queryNativeRuntime(storage, read);
  assert.equal(cold.source.metadata_version, 14);
  assert.equal(JSON.stringify(cold), JSON.stringify(warm));
  assert.equal(negotiations, 1);
  const fallback = await loadNativeContract(read, hash, genesis, 470, 1, true);
  assert.equal(fallback.metadata.version, 14);
  assert.equal(negotiations, 2);
  available = true;
  const result = await queryNativeRuntime(
    {
      operations: [
        {
          kind: "runtime",
          api: "AccountNonceApi",
          member: "account_nonce",
          args: [`0x${"ab".repeat(32)}`],
        },
        { kind: "describe", api: "AccountNonceApi" },
      ],
    },
    read,
  );
  assert.equal(result.source.metadata_version, 15);
  assert.equal(result.results[0].value, "5");
  assert.ok(Array.isArray(result.results[1].value));
  assert.equal(result.results[1].value[0].kind, "runtime");
  assert.equal(negotiations, 3);
  const after = await queryNativeRuntime(storage, read);
  assert.equal(after.source.metadata_version, 15);
  assert.deepEqual(after.results, cold.results);
  assert.equal(negotiations, 3);
  assert.equal(
    source.calls.filter((call) => call.method === "state_getMetadata").length,
    1,
  );
});

test("a failed V15 retry preserves the bounded fallback and upgrading it does not evict another cached code", async () => {
  const source = fixture();
  let unavailable = true;
  const read: BasketRpc = (method, params) =>
    method === "state_call" && unavailable
      ? Promise.reject(new Error("temporary provider failure"))
      : source.read(method, params);
  const older = await loadNativeContract(read, hash, genesis, 470, 1);
  const retry = await loadNativeContract(read, hash, genesis, 470, 1, true);
  assert.equal(retry.metadata, older.metadata);
  const other = fixture(`0x${"cc".repeat(32)}`);
  const retained = await loadNativeContract(other.read, hash, genesis, 470, 1);
  unavailable = false;
  const upgraded = await loadNativeContract(read, hash, genesis, 470, 1, true);
  assert.equal(upgraded.metadata.version, 15);
  assert.equal(
    (await loadNativeContract(other.read, hash, genesis, 470, 1)).metadata,
    retained.metadata,
  );
  assert.equal(
    source.calls.filter((call) => call.method === "state_getMetadata").length,
    1,
  );
  assert.equal(
    other.calls.filter((call) => call.method === "state_call").length,
    1,
  );
});
