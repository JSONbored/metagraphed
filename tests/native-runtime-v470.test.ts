import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import wrapped, {
  V470_METADATA_SHA256,
  V470_RUNTIME_VERSION,
} from "./fixtures/native-v470-compiled.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeHex,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const bare = unwrapNativeMetadata(wrapped)!;
const model = decodeNativeMetadata(bare);
const registry = new TypeRegistry();
const reference = new Metadata(registry, Buffer.from(bare.slice(2), "hex"));
registry.setMetadata(reference);
const hash = `0x${"33".repeat(32)}`;

class UninhabitedType extends Error {
  constructor(readonly id: number) {
    super(`Uninhabited compiled type ${model.types.get(id)!.path.join("::")}`);
  }
}

// Empty/zero values exercise the compiled ABI. They are deliberately synthetic:
// this test neither executes a contract nor represents retained chain history.
function sample(id: number, depth = 0): NativeValue {
  assert.ok(depth < 32, `Unexpected recursive sample type ${id}`);
  const type = model.types.get(id)!.definition;
  const child = (next: number) => sample(next, depth + 1);
  const fields = (
    rows: { name: string | null; type: number }[],
  ): NativeValue => {
    if (rows.length === 1 && rows[0]!.name === null)
      return child(rows[0]!.type);
    if (rows.every((row) => row.name !== null))
      return Object.fromEntries(
        rows.map((row) => [row.name!, child(row.type)]),
      );
    return rows.map((row) => child(row.type));
  };
  switch (type.kind) {
    case "primitive":
      return type.primitive === 0
        ? false
        : type.primitive === 1
          ? "A"
          : type.primitive === 2
            ? ""
            : "0";
    case "compact":
      return "0";
    case "bits":
      return { bit_length: 0, bytes_hex: "0x" };
    case "sequence":
      return [];
    case "array": {
      const element = model.types.get(type.type)!.definition;
      return element.kind === "primitive" && element.primitive === 3
        ? `0x${"00".repeat(type.length)}`
        : Array.from({ length: type.length }, () => child(type.type));
    }
    case "tuple":
      return type.types.map(child);
    case "composite":
      return fields(type.fields);
    case "variant": {
      const variants = [...type.variants].sort(
        (a, b) => Number(b.name === "None") - Number(a.name === "None"),
      );
      for (const variant of variants) {
        try {
          return { variant: variant.name, fields: fields(variant.fields) };
        } catch (error) {
          if (!(error instanceof UninhabitedType)) throw error;
        }
      }
      throw new UninhabitedType(id);
    }
  }
}
function fixture(codeHash: string | null = null) {
  const executions: { method: string; params: unknown[] }[] = [];
  let metadataReads = 0;
  const rpc: BasketRpc = async (method, params) => {
    switch (method) {
      case "chain_getFinalizedHead":
        return hash;
      case "chain_getHeader":
        return { number: "0x1f4" };
      case "chain_getBlockHash":
        return `0x${"44".repeat(32)}`;
      case "state_getRuntimeVersion":
        return V470_RUNTIME_VERSION;
      case "state_getStorageHash":
        return codeHash;
      case "state_call": {
        if (params[0] === "Metadata_metadata_at_version") {
          metadataReads++;
          return wrapped;
        }
        executions.push({ method, params });
        const api = model.apis.find((api) =>
          String(params[0]).startsWith(`${api.name}_`),
        )!;
        const name = String(params[0]).slice(api.name.length + 1);
        const member = api.methods.find((method) => method.name === name)!;
        return nativeHex(
          encodeNativeValue(model, member.output, sample(member.output)),
        );
      }
      default:
        throw new Error(`Unexpected compiled ABI fixture call: ${method}`);
    }
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return { rpc, executions, metadataReads: () => metadataReads };
}

test("full compiled v470 metadata matches the independent reference registry, APIs and every constant", () => {
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(wrapped.slice(2), "hex"))
      .digest("hex"),
    V470_METADATA_SHA256,
  );
  assert.equal(model.types.size, 808);
  assert.equal(model.pallets.length, 28);
  assert.equal(model.apis.length, 25);
  assert.equal(V470_RUNTIME_VERSION.specVersion, 470);
  assert.deepEqual(
    registry.createType("RuntimeVersion", V470_RUNTIME_VERSION).toJSON(),
    V470_RUNTIME_VERSION,
  );
  assert.deepEqual(
    [...model.types.values()].map((row) => [row.id, row.path]),
    reference.asV15.lookup.types.map((row) => [
      row.id.toNumber(),
      row.type.path.map(String),
    ]),
  );
  assert.deepEqual(
    model.pallets.map((row) => [row.name, row.index]),
    reference.asV15.pallets.map((row) => [
      row.name.toString(),
      row.index.toNumber(),
    ]),
  );
  assert.deepEqual(
    model.apis,
    reference.asV15.apis.map((api) => ({
      name: api.name.toString(),
      methods: api.methods.map((method) => ({
        name: method.name.toString(),
        inputs: method.inputs.map((input) => ({
          name: input.name.toString(),
          type: input.type.toNumber(),
        })),
        output: method.output.toNumber(),
      })),
    })),
  );
  let constants = 0;
  for (const pallet of model.pallets)
    for (const constant of pallet.constants) {
      const bytes = encodeNativeValue(
        model,
        constant.type,
        decodeNativeValue(model, constant.type, constant.value),
      );
      assert.equal(
        nativeHex(bytes),
        constant.value,
        `${pallet.name}.${constant.name}`,
      );
      const independent = registry.createTypeUnsafe(`Lookup${constant.type}`, [
        Buffer.from(constant.value.slice(2), "hex"),
      ]);
      assert.equal(independent.encodedLength, bytes.length);
      assert.equal(nativeHex(independent.toU8a()), constant.value);
      constants++;
    }
  assert.ok(constants > 0);
  console.log(
    "NATIVE_V470_COMPILED_ABI_FIXTURE",
    JSON.stringify({
      types: model.types.size,
      pallets: model.pallets.length,
      apis: model.apis.length,
      constants,
      fixture: true,
      production: false,
    }),
  );
});

test("every compiled v470 pallet call can be prepared and independently decoded with the exact pallet and call indices", async () => {
  let prepared = 0;
  const uninhabited: string[] = [];
  const f = fixture(`0x${"77".repeat(32)}`);
  for (const pallet of model.pallets) {
    if (pallet.calls === null) continue;
    const calls = model.types.get(pallet.calls)!.definition;
    assert.equal(calls.kind, "variant");
    if (calls.kind !== "variant") continue;
    for (const call of calls.variants) {
      let args: NativeValue[];
      try {
        args = call.fields.map((field) => sample(field.type));
      } catch (error) {
        if (!(error instanceof UninhabitedType)) throw error;
        // Grandpa's configured Void key-ownership proof has no value. It
        // cannot be fabricated into a callable extrinsic by any client.
        assert.equal(pallet.name, "Grandpa");
        assert.match(call.name, /^report_equivocation/);
        assert.throws(
          () =>
            encodeNativeValue(model, error.id, { variant: "Void", fields: {} }),
          /Invalid native enum variant/,
        );
        uninhabited.push(`${pallet.name}.${call.name}`);
        continue;
      }
      const result = await queryNativeRuntime(
        {
          as_of: hash,
          operations: [
            { kind: "prepare", pallet: pallet.name, member: call.name, args },
          ],
        },
        f.rpc,
      );
      const encoded = result.results[0]!.call_data!;
      const independent = registry.createType(
        "Call",
        Buffer.from(encoded.slice(2), "hex"),
      );
      assert.deepEqual(
        [...independent.callIndex],
        [pallet.index, call.index],
        `${pallet.name}.${call.name}`,
      );
      assert.equal(nativeHex(independent.toU8a()), encoded);
      assert.equal(independent.encodedLength, (encoded.length - 2) / 2);
      prepared++;
    }
  }
  assert.ok(prepared > 0);
  assert.equal(f.executions.length, 0);
  console.log(
    "NATIVE_V470_PREPARED_CALL_FIXTURE",
    JSON.stringify({
      prepared_calls: prepared,
      uninhabited_proof_calls: uninhabited,
      execution_rpcs: 0,
      fixture: true,
      production: false,
    }),
  );
}, 60000);

test("compiled v470 EVM and Wasm runtime signatures encode exact bounded execution requests including authorization_list", async () => {
  for (const [apiName, memberName] of [
    ["EthereumRuntimeRPCApi", "call"],
    ["EthereumRuntimeRPCApi", "create"],
    ["ContractsApi", "call"],
    ["ContractsApi", "instantiate"],
    ["ContractsApi", "upload_code"],
  ]) {
    const api = model.apis.find((row) => row.name === apiName)!;
    const member = api.methods.find((row) => row.name === memberName)!;
    const args = member.inputs.map((field) => sample(field.type));
    member.inputs.forEach((field, index) => {
      if (field.name === "gas_limit")
        args[index] =
          apiName === "ContractsApi"
            ? {
                variant: "Some",
                fields: { ref_time: "100000000000", proof_size: "32768" },
              }
            : ["500000", "0", "0", "0"];
    });
    if (apiName === "EthereumRuntimeRPCApi")
      assert.ok(
        member.inputs.some((field) => field.name === "authorization_list"),
      );
    const f = fixture();
    const result = await queryNativeRuntime(
      {
        operations: [
          { kind: "runtime", api: apiName, member: memberName, args },
        ],
      },
      f.rpc,
    );
    assert.equal(f.executions.length, 1);
    const pieces = member.inputs.map((field, index) => {
      const encoded = encodeNativeValue(model, field.type, args[index]!);
      const independent = registry.createTypeUnsafe(`Lookup${field.type}`, [
        encoded,
      ]);
      assert.equal(independent.encodedLength, encoded.length);
      assert.equal(nativeHex(independent.toU8a()), nativeHex(encoded));
      return encoded;
    });
    assert.deepEqual(f.executions[0]!.params, [
      `${apiName}_${memberName}`,
      nativeHex(Buffer.concat(pieces)),
      hash,
    ]);
    const output = encodeNativeValue(
      model,
      member.output,
      result.results[0]!.value!,
    );
    const independent = registry.createTypeUnsafe(`Lookup${member.output}`, [
      output,
    ]);
    assert.equal(independent.encodedLength, output.length);
    assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
  }
});

test("warm compiled v470 contracts remove the full metadata transfer and parse while preserving response bytes", async () => {
  const f = fixture(`0x${"88".repeat(32)}`);
  const input = {
    operations: [{ kind: "constant", pallet: "System", member: "SS58Prefix" }],
  };
  const cold = await queryNativeRuntime(input, f.rpc);
  const warm = await queryNativeRuntime(input, f.rpc);
  assert.equal(JSON.stringify(warm), JSON.stringify(cold));
  assert.equal(f.metadataReads(), 1);
  assert.equal(f.executions.length, 0);
  console.log(
    "NATIVE_V470_METADATA_REUSE_FIXTURE",
    JSON.stringify({
      metadata_reads_removed: 1,
      metadata_decodes_removed: 1,
      metadata_wire_hex_bytes_removed: Buffer.byteLength(wrapped),
      identity_hex_bytes_added: 66,
      response_bytes: Buffer.byteLength(JSON.stringify(warm)),
      bytes_equal: true,
      fixture: true,
      production: false,
    }),
  );
});

test("all compiled ShieldApi decode methods are usable reads with exact reference bytes and no submission path", async () => {
  const api = model.apis.find((row) => row.name === "ShieldApi")!;
  assert.deepEqual(
    api.methods.map((row) => row.name),
    [
      "try_decode_shielded_tx",
      "is_shielded_using_current_key",
      "try_unshield_tx",
    ],
  );
  const f = fixture();
  const description = await queryNativeRuntime(
    { operations: [{ kind: "describe", api: api.name }] },
    f.rpc,
  );
  assert.equal((description.results[0]!.value as NativeValue[]).length, 3);
  for (const member of api.methods) {
    const args = member.inputs.map((field) => sample(field.type));
    const result = await queryNativeRuntime(
      {
        operations: [
          { kind: "runtime", api: api.name, member: member.name, args },
        ],
      },
      f.rpc,
    );
    const output = encodeNativeValue(
      model,
      member.output,
      result.results[0]!.value!,
    );
    const independent = registry.createTypeUnsafe(`Lookup${member.output}`, [
      output,
    ]);
    assert.equal(independent.encodedLength, output.length);
    assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
  }
  assert.deepEqual(
    f.executions.map((row) => row.params[0]),
    api.methods.map((row) => `${api.name}_${row.name}`),
  );
});
