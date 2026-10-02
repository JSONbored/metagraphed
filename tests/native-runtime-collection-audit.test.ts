import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { Metadata } from "@polkadot/types/metadata";
import { TypeRegistry } from "@polkadot/types/create";
import wrapped, {
  V470_RUNTIME_VERSION,
} from "./fixtures/native-v470-compiled.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  NATIVE_RUNTIME_LIMITS,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeCompact,
  nativeHex,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { handleNativeRuntime } from "../workers/request-handlers/native-runtime.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

afterEach(() => vi.restoreAllMocks());

test("compiled v470 neuron collection establishes the bounded wire and decoded-value gap", async () => {
  const bare = unwrapNativeMetadata(wrapped)!;
  const model = decodeNativeMetadata(bare);
  const method = model.apis
    .find((row) => row.name === "NeuronInfoRuntimeApi")!
    .methods.find((row) => row.name === "get_neurons")!;
  const collection = model.types.get(method.output)!.definition;
  assert.equal(collection.kind, "sequence");
  if (collection.kind !== "sequence")
    throw new Error("Expected compiled neuron vector");
  const rows = Array.from({ length: 256 }, (_, uid) => {
    const row = sampleNativeValue(model, collection.type);
    assert.ok(row !== null && typeof row === "object" && !Array.isArray(row));
    return {
      ...row,
      uid: String(uid),
      netuid: "19",
      active: true,
      stake: [[`0x${"22".repeat(32)}`, "9007199254740993"]],
      weights: Array.from({ length: 32 }, (_, index) => [
        String(index),
        "65535",
      ]),
      bonds: Array.from({ length: 32 }, (_, index) => [String(index), "1"]),
      validator_permit: true,
      last_update: "9007199254740993",
    };
  });
  const bytes = Buffer.concat([
    nativeCompact(BigInt(rows.length)),
    ...rows.map((row) => encodeNativeValue(model, collection.type, row)),
  ]);
  const hex = nativeHex(bytes);
  assert.ok(bytes.length < NATIVE_RUNTIME_LIMITS.valueBytes);
  const registry = new TypeRegistry();
  registry.setMetadata(
    new Metadata(registry, Buffer.from(bare.slice(2), "hex")),
  );
  const independent = registry.createTypeUnsafe(`Lookup${method.output}`, [
    bytes,
  ]);
  assert.equal(independent.encodedLength, bytes.length);
  assert.equal(nativeHex(independent.toU8a()), hex);
  assert.throws(
    () => decodeNativeValue(model, method.output, hex),
    /work budget/,
  );
  assert.deepEqual(
    decodeNativeValue(
      model,
      collection.type,
      nativeHex(encodeNativeValue(model, collection.type, rows[0]!)),
    ),
    rows[0],
  );
  const at = `0x${"33".repeat(32)}`;
  let executions = 0;
  const rpc: BasketRpc = async (name, params) => {
    if (name === "chain_getFinalizedHead") return at;
    if (name === "chain_getHeader") return { number: "0x1f4" };
    if (name === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
    if (name === "state_getRuntimeVersion") return V470_RUNTIME_VERSION;
    if (name === "state_getStorageHash") return `0x${"78".repeat(32)}`;
    assert.equal(name, "state_call");
    if (params[0] === "Metadata_metadata_at_version") return wrapped;
    assert.equal(params[0], "NeuronInfoRuntimeApi_get_neurons");
    assert.equal(params[2], at);
    executions++;
    return hex;
  };
  rpc.batch = (requests) =>
    Promise.all(requests.map((row) => rpc(row.method, row.params)));
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          {
            kind: "runtime",
            api: "NeuronInfoRuntimeApi",
            member: "get_neurons",
            args: [19],
          },
        ],
      },
      rpc,
    ),
    /work budget/,
  );
  assert.equal(executions, 1);
  const operation = {
    kind: "runtime", api: "NeuronInfoRuntimeApi", member: "get_neurons", args: [19],
    value_page: { path: [], offset: 0, limit: 16 },
  };
  const paged = await queryNativeRuntime({ as_of: at, operations: [
    operation, operation, { ...operation, value_page: { ...operation.value_page, offset: 16 } },
  ] }, rpc);
  assert.equal(executions, 2);
  assert.deepEqual(paged.results[0]!.value, rows.slice(0, 16));
  assert.deepEqual(paged.results[1]!.value, rows.slice(0, 16));
  assert.notEqual(paged.results[0]!.value, paged.results[1]!.value);
  assert.deepEqual(paged.results[2]!.value, rows.slice(16, 32));
  assert.equal(paged.results[0]!.value_page!.total, 256);
  assert.equal(paged.results[0]!.value_page!.next_offset, 16);
  const collected = [...paged.results[0]!.value as NativeValue[], ...paged.results[2]!.value as NativeValue[]];
  for (let offset = 32; offset < rows.length; offset += 16) {
    const next = await queryNativeRuntime({ as_of: at, operations: [
      { ...operation, value_page: { ...operation.value_page, offset } },
    ] }, rpc);
    collected.push(...next.results[0]!.value as NativeValue[]);
    assert.equal(next.results[0]!.value_page!.next_offset, offset + 16 === rows.length ? null : offset + 16);
  }
  assert.deepEqual(collected, rows);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const requests = JSON.parse(String(init?.body));
    const reply = async (request: { id: unknown; method: string; params: unknown[] }) =>
      ({ jsonrpc: "2.0", id: request.id, result: await rpc(request.method, request.params) });
    return Response.json(Array.isArray(requests) ? await Promise.all(requests.map(reply)) : await reply(requests));
  });
  const env = apiEnv(createLocalArtifactEnv());
  const input = { as_of: at, operations: [operation] };
  const rest = await handleNativeRuntime(new Request("https://api.metagraph.sh/api/v1/native-runtime", {
    method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" },
  }), env);
  assert.equal(rest.status, 200);
  const envelope = await rest.json() as { data: unknown };
  const mcp = await MCP_TOOLS.find((row) => row.name === "get_native_runtime")!.handler(input, { env, clientIp: "192.0.2.1" });
  assert.equal(JSON.stringify(mcp), JSON.stringify(envelope.data));
  const beforeInvalid = executions;
  for (const input of [
    { operations: [{ ...operation, value_page: { ...operation.value_page, offset: 1 } }] },
    { operations: [{ ...operation, value_page: { ...operation.value_page, path: ["missing"] } }] },
    { operations: [{ ...operation, value_page: { ...operation.value_page, limit: 0 } }] },
    { operations: Array(5).fill(operation) },
    { operations: [{ kind: "runtime_scale", api: operation.api, member: operation.member, input: "0x1300", value_page: operation.value_page }] },
  ]) await assert.rejects(queryNativeRuntime(input, rpc));
  assert.equal(executions, beforeInvalid);
  console.log(
    "NATIVE_COLLECTION_BASELINE",
    JSON.stringify({
      runtime_spec: 470,
      source_commit: "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d",
      neurons: rows.length,
      weights_per_neuron: 32,
      bonds_per_neuron: 32,
      wire_bytes: bytes.length,
      wire_budget: NATIVE_RUNTIME_LIMITS.valueBytes,
      response_json_bytes: Buffer.byteLength(JSON.stringify(rows)),
      decoded_item_budget: NATIVE_RUNTIME_LIMITS.items,
      ordinary_full_value: "work_budget_rejected",
      baseline_upstream_requests: 1,
      page_neurons: 16,
      first_page_json_bytes: Buffer.byteLength(JSON.stringify(paged.results[0]!.value)),
      duplicate_and_distinct_page_upstream_requests: 1,
      full_collection_reconstructed: true,
      unchanged_default_rejection: true,
      fixture: true,
      production: false,
    }),
  );
});
