import assert from "node:assert/strict";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import eras from "./fixtures/native-runtime-legacy-compiled.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
} from "../src/native-runtime-metadata.ts";
import {
  encodeNativeValue,
  decodeNativeValue,
  nativeHex,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import {
  describeRuntimeEvm,
  encodeRuntimeEvmCall,
} from "../src/evm-runtime-abi.ts";
import { evmRuntimeCatalogue } from "../src/evm-runtime-catalogue.ts";
import { decodeRuntimeEvmCall } from "../src/evm-runtime-calldata.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const at = `0x${"33".repeat(32)}`;
const to = `0x${(2048).toString(16).padStart(40, "0")}`;
const evm_call = {
  signature: "transfer(bytes32)",
  args: [`0x${"ab".repeat(32)}`],
};

test("the first published compiled era has no EVM; later signatures are not retroactively assigned", () => {
  assert.equal(describeRuntimeEvm(205, true, 0, 64).contract.total, 0);
  assert.equal(decodeRuntimeEvmCall(205, to, "0x00000000")!.function, null);
  const old = describeRuntimeEvm(
    210,
    `0x${(2049).toString(16).padStart(40, "0")}`,
    0,
    64,
  );
  assert.deepEqual(
    old.value.map((row) => "signature" in row && row.signature),
    ["addStake(bytes32,uint16)", "removeStake(bytes32,uint256,uint16)"],
  );
  assert.throws(
    () =>
      encodeRuntimeEvmCall(
        210,
        `0x${(2049).toString(16).padStart(40, "0")}`,
        "addStake(bytes32,uint256)",
        [],
      ),
    /Unknown EVM signature/,
  );
  assert.throws(
    () =>
      describeRuntimeEvm(
        210,
        `0x${(2053).toString(16).padStart(40, "0")}`,
        0,
        64,
      ),
    /Unknown EVM precompile/,
  );
});

for (const era of eras.slice(1)) {
  test(`compiled ${era.tag} typed EVM uses its exact runtime and both native call formats`, async () => {
    assert.equal(
      evmRuntimeCatalogue.releases.find((row) => row[0] === era.spec)![1],
      era.commit,
    );
    const encoded = encodeRuntimeEvmCall(
      era.spec,
      to,
      evm_call.signature,
      evm_call.args,
    );
    assert.deepEqual(encoded.outputs, []);
    const v15 = decodeNativeMetadata(unwrapNativeMetadata(era.v15)!);
    const method = v15.apis
      .find((row) => row.name === "EthereumRuntimeRPCApi")!
      .methods.find((row) => row.name === "call")!;
    const returned = sampleNativeValue(v15, method.output) as {
      variant: string;
      fields: {
        exit_reason: NativeValue;
        value: string;
        [key: string]: NativeValue;
      };
    };
    assert.equal(returned.variant, "Ok");
    returned.fields.exit_reason = {
      variant: "Succeed",
      fields: { variant: "Returned", fields: {} },
    };
    returned.fields.value = "0x";
    function fixture(format: 14 | 15) {
      const calls: { method: string; params: unknown[] }[] = [];
      const rpc: BasketRpc = async (methodName, params) => {
        if (methodName === "chain_getFinalizedHead") return at;
        if (methodName === "chain_getHeader") return { number: "0x1f4" };
        if (methodName === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
        if (methodName === "state_getRuntimeVersion") return era.runtimeVersion;
        if (methodName === "state_getStorageHash")
          return `0x${(era.spec * 100 + format).toString(16).padStart(64, "0")}`;
        if (methodName === "state_getMetadata")
          return unwrapNativeMetadata(era.v14);
        assert.equal(methodName, "state_call");
        if (params[0] === "Metadata_metadata_at_version")
          return format === 15 ? era.v15 : "0x00";
        assert.equal(params[0], "EthereumRuntimeRPCApi_call");
        calls.push({ method: methodName, params });
        return nativeHex(encodeNativeValue(v15, method.output, returned));
      };
      rpc.batch = (rows) =>
        Promise.all(rows.map((row) => rpc(row.method, row.params)));
      return { rpc, calls };
    }
    for (const format of [14, 15] as const) {
      const bare = unwrapNativeMetadata(era[`v${format}`])!,
        model = decodeNativeMetadata(bare),
        registry = new TypeRegistry();
      registry.setMetadata(
        new Metadata(registry, Buffer.from(bare.slice(2), "hex")),
      );
      const pallet = model.pallets.find((row) => row.name === "EVM")!,
        variants = model.types.get(pallet.calls!)!.definition;
      assert.equal(variants.kind, "variant");
      if (variants.kind !== "variant") throw new Error("EVM call type");
      const call = variants.variants.find((row) => row.name === "call")!;
      const args = call.fields.map((field) =>
        field.name === "target"
          ? to
          : field.name === "input"
            ? "0x"
            : sampleNativeValue(model, field.type),
      );
      const expected = Buffer.concat([
        Buffer.from([pallet.index, call.index]),
        ...call.fields.map((field, index) =>
          registry
            .createTypeUnsafe(`Lookup${field.type}`, [
              encodeNativeValue(
                model,
                field.type,
                field.name === "input" ? encoded.input : args[index]!,
              ),
            ])
            .toU8a(),
        ),
      ]);
      const f = fixture(format),
        response = await queryNativeRuntime(
          {
            operations: [
              {
                kind: "prepare",
                pallet: "EVM",
                member: "call",
                args,
                evm_call,
              },
              { kind: "describe", evm: to },
            ],
          },
          f.rpc,
        );
      assert.equal(response.results[0]!.call_data, nativeHex(expected));
      assert.equal(f.calls.length, 0);
      assert.equal(
        (
          response.results[0]!.contract as {
            evm_call: { source_commit: string };
          }
        ).evm_call.source_commit,
        era.commit,
      );
      assert.equal(response.source.metadata_version, format);
    }
    const args = method.inputs.map((field) => {
      if (field.name === "to") return to;
      if (field.name === "data") return "0x";
      const value = sampleNativeValue(v15, field.type);
      if (field.name === "gas_limit")
        return Array.isArray(value) ? ["500000", "0", "0", "0"] : "500000";
      return value;
    });
    const operation = {
        kind: "runtime",
        api: "EthereumRuntimeRPCApi",
        member: "call",
        args,
        evm_call,
      },
      f = fixture(15);
    const response = await queryNativeRuntime(
      { operations: [operation, operation] },
      f.rpc,
    );
    const registry = new TypeRegistry();
    registry.setMetadata(
      new Metadata(
        registry,
        Buffer.from(unwrapNativeMetadata(era.v15)!.slice(2), "hex"),
      ),
    );
    const expected = Buffer.concat(
      method.inputs.map((field, index) =>
        registry
          .createTypeUnsafe(`Lookup${field.type}`, [
            encodeNativeValue(
              v15,
              field.type,
              field.name === "data" ? encoded.input : args[index]!,
            ),
          ])
          .toU8a(),
      ),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.params[1], nativeHex(expected));
    assert.deepEqual(response.results[0], response.results[1]);
    assert.deepEqual(response.results[0]!.evm_result, {
      status: "decoded",
      values: [],
    });
    assert.deepEqual(
      response.results[0]!.value,
      decodeNativeValue(
        v15,
        method.output,
        nativeHex(encodeNativeValue(v15, method.output, returned)),
      ),
    );
    console.log(
      "LEGACY_EVM_NATIVE_FIXTURE",
      JSON.stringify({
        tag: era.tag,
        spec: era.spec,
        preparation_formats: 2,
        execution_abi_cases: 1,
        duplicate_execution_requests: 1,
        compiled_source: era.commit,
        fixture: true,
        production: false,
      }),
    );
  });
}
