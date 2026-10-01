import assert from "node:assert/strict";
import { test } from "vitest";
import { nativeRuntimeRpc } from "../src/native-runtime-rpc.ts";
import { NATIVE_RUNTIME_LIMITS } from "../src/native-runtime-metadata.ts";

test("native transport binds the selected network and restores shuffled batch responses", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(url), body });
    const reply = (call: { id: number; method: string }) => ({ jsonrpc: "2.0", id: call.id, result: call.method });
    return Response.json(Array.isArray(body) ? body.map(reply).reverse() : reply(body));
  };
  const testnet = nativeRuntimeRpc("testnet", fetchImpl);
  assert.equal(await testnet("state_getStorageHash", ["0x3a636f6465", "0x33"]), "state_getStorageHash");
  assert.deepEqual(await testnet.batch!([
    { method: "chain_getHeader", params: ["0x33"] },
    { method: "state_getRuntimeVersion", params: ["0x33"] },
  ]), ["chain_getHeader", "state_getRuntimeVersion"]);
  assert.deepEqual(await testnet.batch!([]), []);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((call) => call.url === "https://test.finney.opentensor.ai:443"));
  await nativeRuntimeRpc("mainnet", fetchImpl)("chain_getFinalizedHead", []);
  assert.equal(seen.at(-1)!.url, "https://entrypoint-finney.opentensor.ai:443");
});

test("native transport refuses writes and excessive batches before reaching fetch", async () => {
  let reads = 0;
  const read = nativeRuntimeRpc("mainnet", async () => { reads++; throw new Error("unexpected fetch"); });
  await assert.rejects(read("author_submitExtrinsic", ["0x00"]), /read-only/);
  await assert.rejects(read.batch!([{ method: "author_rotateKeys", params: [] }]), /read-only/);
  await assert.rejects(read.batch!(Array.from({ length: 17 }, () => ({ method: "state_getStorage", params: [] }))), /work budget/);
  assert.equal(reads, 0);
});

test("native metadata wire budget accommodates its hex expansion and rejects an oversized stream", async () => {
  const value = `0x${"00".repeat(NATIVE_RUNTIME_LIMITS.metadataBytes)}`;
  const accepted = nativeRuntimeRpc("mainnet", async (_url, init) => {
    const call = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id: call.id, result: value });
  });
  assert.equal(await accepted("state_getMetadata", ["0x33"]), value);
  const declined = nativeRuntimeRpc("mainnet", async () => new Response(" ".repeat(2 * NATIVE_RUNTIME_LIMITS.metadataBytes + 65_537)));
  await assert.rejects(declined("state_getMetadata", []), /budget|JSON/);
});

test("a failed batch leg fails the request rather than producing an absent value", async () => {
  const read = nativeRuntimeRpc("mainnet", async (_url, init) => {
    const calls = JSON.parse(String(init?.body));
    return Response.json(calls.map((call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, error: { code: -32603, message: "fixture failure" } })));
  });
  await assert.rejects(read.batch!([{ method: "state_getStorage", params: ["0x00"] }]), /batch failed/);
});
