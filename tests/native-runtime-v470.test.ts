import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import wrapped, { V470_METADATA_SHA256 } from "./fixtures/native-v470-compiled.ts";
import { decodeNativeMetadata, unwrapNativeMetadata } from "../src/native-runtime-metadata.ts";
import { decodeNativeValue, encodeNativeValue, nativeHex, type NativeValue } from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { runtimeApiId } from "../src/native-runtime-scale.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const bare = unwrapNativeMetadata(wrapped)!;
const model = decodeNativeMetadata(bare);
const registry = new TypeRegistry();
const reference = new Metadata(registry, Buffer.from(bare.slice(2), "hex"));
registry.setMetadata(reference);
const hash = `0x${"33".repeat(32)}`;

// Empty/zero values exercise the compiled ABI. They are deliberately synthetic:
// this test neither executes a contract nor represents retained chain history.
function sample(id: number, depth = 0): NativeValue {
  assert.ok(depth < 32, `Unexpected recursive sample type ${id}`);
  const type = model.types.get(id)!.definition;
  const child = (next: number) => sample(next, depth + 1);
  const fields = (rows: { name: string | null; type: number }[]): NativeValue => {
    if (rows.length === 1 && rows[0]!.name === null) return child(rows[0]!.type);
    if (rows.every((row) => row.name !== null)) return Object.fromEntries(rows.map((row) => [row.name!, child(row.type)]));
    return rows.map((row) => child(row.type));
  };
  switch (type.kind) {
    case "primitive": return type.primitive === 0 ? false : type.primitive === 1 ? "A" : type.primitive === 2 ? "" : "0";
    case "compact": return "0";
    case "bits": return { bit_length: 0, bytes_hex: "0x" };
    case "sequence": return [];
    case "array": {
      const element = model.types.get(type.type)!.definition;
      return element.kind === "primitive" && element.primitive === 3 ? `0x${"00".repeat(type.length)}` : Array.from({ length: type.length }, () => child(type.type));
    }
    case "tuple": return type.types.map(child);
    case "composite": return fields(type.fields);
    case "variant": {
      const variant = type.variants.find((row) => row.name === "None") ?? type.variants[0]!;
      return { variant: variant.name, fields: fields(variant.fields) };
    }
  }
}
function fixture() {
  const executions: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (method, params) => {
    switch (method) {
      case "chain_getFinalizedHead": return hash;
      case "chain_getHeader": return { number: "0x1f4" };
      case "chain_getBlockHash": return `0x${"44".repeat(32)}`;
      case "state_getRuntimeVersion": return { specName: "node-subtensor", specVersion: 470, transactionVersion: 1, apis: model.apis.map((api) => [runtimeApiId(api.name), api.name === "BetaBasketRuntimeApi" ? 5 : 1]) };
      case "state_getStorageHash": return null;
      case "state_call": {
        if (params[0] === "Metadata_metadata_at_version") return wrapped;
        executions.push({ method, params });
        const api = model.apis.find((api) => String(params[0]).startsWith(`${api.name}_`))!;
        const name = String(params[0]).slice(api.name.length + 1);
        const member = api.methods.find((method) => method.name === name)!;
        return nativeHex(encodeNativeValue(model, member.output, sample(member.output)));
      }
      default: throw new Error(`Unexpected compiled ABI fixture call: ${method}`);
    }
  };
  rpc.batch = async (rows) => Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return { rpc, executions };
}

test("full compiled v470 metadata matches the independent reference registry, APIs and every constant", () => {
  assert.equal(createHash("sha256").update(Buffer.from(wrapped.slice(2), "hex")).digest("hex"), V470_METADATA_SHA256);
  assert.equal(model.types.size, 808);
  assert.equal(model.pallets.length, 28);
  assert.equal(model.apis.length, 25);
  assert.deepEqual([...model.types.values()].map((row) => [row.id, row.path]), reference.asV15.lookup.types.map((row) => [row.id.toNumber(), row.type.path.map(String)]));
  assert.deepEqual(model.pallets.map((row) => [row.name, row.index]), reference.asV15.pallets.map((row) => [row.name.toString(), row.index.toNumber()]));
  assert.deepEqual(model.apis, reference.asV15.apis.map((api) => ({ name: api.name.toString(), methods: api.methods.map((method) => ({ name: method.name.toString(), inputs: method.inputs.map((input) => ({ name: input.name.toString(), type: input.type.toNumber() })), output: method.output.toNumber() })) })));
  let constants = 0;
  for (const pallet of model.pallets) for (const constant of pallet.constants) {
    const bytes = encodeNativeValue(model, constant.type, decodeNativeValue(model, constant.type, constant.value));
    assert.equal(nativeHex(bytes), constant.value, `${pallet.name}.${constant.name}`);
    const independent = registry.createTypeUnsafe(`Lookup${constant.type}`, [Buffer.from(constant.value.slice(2), "hex")]);
    assert.equal(independent.encodedLength, bytes.length);
    assert.equal(nativeHex(independent.toU8a()), constant.value);
    constants++;
  }
  assert.ok(constants > 0);
  console.log("NATIVE_V470_COMPILED_ABI_FIXTURE", JSON.stringify({ types: model.types.size, pallets: model.pallets.length, apis: model.apis.length, constants, fixture: true, production: false }));
});

test("every compiled v470 pallet call can be prepared and independently decoded with the exact pallet and call indices", async () => {
  let prepared = 0;
  const f = fixture();
  for (const pallet of model.pallets) {
    if (pallet.calls === null) continue;
    const calls = model.types.get(pallet.calls)!.definition;
    assert.equal(calls.kind, "variant");
    if (calls.kind !== "variant") continue;
    for (const call of calls.variants) {
      const args = call.fields.map((field) => sample(field.type));
      const result = await queryNativeRuntime({ as_of: hash, operations: [{ kind: "prepare", pallet: pallet.name, member: call.name, args }] }, f.rpc);
      const encoded = result.results[0]!.call_data!;
      const independent = registry.createType("Call", Buffer.from(encoded.slice(2), "hex"));
      assert.deepEqual([...independent.callIndex], [pallet.index, call.index], `${pallet.name}.${call.name}`);
      assert.equal(nativeHex(independent.toU8a()), encoded);
      assert.equal(independent.encodedLength, (encoded.length - 2) / 2);
      prepared++;
    }
  }
  assert.ok(prepared > 0);
  assert.equal(f.executions.length, 0);
  console.log("NATIVE_V470_PREPARED_CALL_FIXTURE", JSON.stringify({ prepared_calls: prepared, execution_rpcs: 0, fixture: true, production: false }));
}, 30000);

test("compiled v470 EVM and Wasm runtime signatures encode exact bounded execution requests including authorization_list", async () => {
  for (const [apiName, memberName] of [["EthereumRuntimeRPCApi", "call"], ["EthereumRuntimeRPCApi", "create"], ["ContractsApi", "call"], ["ContractsApi", "instantiate"], ["ContractsApi", "upload_code"]]) {
    const api = model.apis.find((row) => row.name === apiName)!;
    const member = api.methods.find((row) => row.name === memberName)!;
    const args = member.inputs.map((field) => sample(field.type));
    member.inputs.forEach((field, index) => {
      if (field.name === "gas_limit") args[index] = apiName === "ContractsApi" ? { variant: "Some", fields: { ref_time: "100000000000", proof_size: "32768" } } : ["500000", "0", "0", "0"];
    });
    if (apiName === "EthereumRuntimeRPCApi") assert.ok(member.inputs.some((field) => field.name === "authorization_list"));
    const f = fixture();
    const result = await queryNativeRuntime({ operations: [{ kind: "runtime", api: apiName, member: memberName, args }] }, f.rpc);
    assert.equal(f.executions.length, 1);
    const pieces = member.inputs.map((field, index) => {
      const encoded = encodeNativeValue(model, field.type, args[index]!);
      const independent = registry.createTypeUnsafe(`Lookup${field.type}`, [encoded]);
      assert.equal(independent.encodedLength, encoded.length);
      assert.equal(nativeHex(independent.toU8a()), nativeHex(encoded));
      return encoded;
    });
    assert.deepEqual(f.executions[0]!.params, [`${apiName}_${memberName}`, nativeHex(Buffer.concat(pieces)), hash]);
    const output = encodeNativeValue(model, member.output, result.results[0]!.value!);
    const independent = registry.createTypeUnsafe(`Lookup${member.output}`, [output]);
    assert.equal(independent.encodedLength, output.length);
    assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
  }
});
