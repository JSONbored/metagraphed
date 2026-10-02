import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import { decorateStorage } from "@polkadot/types/metadata/decorate/storage";
import { stringCamelCase } from "@polkadot/util";
import eras from "./fixtures/native-runtime-legacy-compiled.ts";
import {
  sampleNativeValue,
  UninhabitedType,
} from "./fixtures/native-compiled-values.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeHex,
  nativeStorageKey,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { SCALE_READ_API_METHODS } from "../src/native-runtime-scale.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const at = `0x${"33".repeat(32)}`;
const pureApis = new Set([
  "DelegateInfoRuntimeApi",
  "NeuronInfoRuntimeApi",
  "SubnetInfoRuntimeApi",
  "StakeInfoRuntimeApi",
  "SubnetRegistrationRuntimeApi",
  "BetaBasketRuntimeApi",
  "ProxyFilterRuntimeApi",
  "SwapRuntimeApi",
  "AccountNonceApi",
  "TransactionPaymentApi",
  "TransactionPaymentCallApi",
]);
assert.equal(eras.length, 65);
assert.equal(new Set(eras.map((era) => era.tag)).size, 65);
assert.equal(eras[0]!.tag, "v1.1.7");
assert.equal(eras.at(-1)!.tag, "v3.4.9-424");

for (const era of eras) {
  for (const version of [14, 15] as const) {
    test(`compiled ${era.tag} spec ${era.spec} V${version} supports its exact storage, constants and every inhabitable native call`, async () => {
      const wrapped = era[`v${version}`];
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(wrapped.slice(2), "hex"))
          .digest("hex"),
        era[`v${version}_sha256`],
      );
      assert.equal(era.spec, era.runtimeVersion.specVersion);
      assert.match(era.commit, /^[0-9a-f]{40}$/);
      assert.match(era.wasm_sha256, /^[0-9a-f]{64}$/);
      assert.match(era.digest_sha256, /^[0-9a-f]{64}$/);
      const bare = unwrapNativeMetadata(wrapped)!;
      const model = decodeNativeMetadata(bare);
      const registry = new TypeRegistry();
      const reference = new Metadata(
        registry,
        Buffer.from(bare.slice(2), "hex"),
      );
      registry.setMetadata(reference);
      const view = version === 14 ? reference.asV14 : reference.asV15;
      const storageReference = decorateStorage(
        registry,
        reference.asLatest,
        version,
      );
      assert.deepEqual(
        model.pallets.map((row) => [row.name, row.index]),
        view.pallets.map((row) => [row.name.toString(), row.index.toNumber()]),
      );
      assert.deepEqual(
        [...model.types.values()].map((row) => [row.id, row.path]),
        view.lookup.types.map((row) => [
          row.id.toNumber(),
          row.type.path.map(String),
        ]),
      );
      const calls: string[] = [];
      const values = new Map<string, string>();
      const rpc: BasketRpc = async (method, params) => {
        if (method === "chain_getFinalizedHead") return at;
        if (method === "chain_getHeader") return { number: "0x1f4" };
        if (method === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
        if (method === "state_getRuntimeVersion") return era.runtimeVersion;
        if (method === "state_getStorageHash")
          return `0x${createHash("sha256").update(`${era.wasm_sha256}:${version}`).digest("hex")}`;
        if (method === "state_getMetadata")
          return unwrapNativeMetadata(era.v14);
        if (
          method === "state_call" &&
          params[0] === "Metadata_metadata_at_version"
        )
          return version === 15 ? era.v15 : "0x00";
        calls.push(method);
        assert.equal(method, "state_getStorage");
        assert.equal(params[1], at);
        assert.ok(values.has(String(params[0])));
        return values.get(String(params[0]));
      };
      rpc.batch = (rows) =>
        Promise.all(rows.map((row) => rpc(row.method, row.params)));
      let constants = 0,
        storage = 0,
        prefixes = 0,
        prepared = 0;
      const voidCalls: string[] = [];
      for (const pallet of model.pallets) {
        for (const constant of pallet.constants) {
          const decoded = decodeNativeValue(
            model,
            constant.type,
            constant.value,
          );
          const bytes = encodeNativeValue(model, constant.type, decoded);
          assert.equal(nativeHex(bytes), constant.value);
          const expected = registry.createTypeUnsafe(`Lookup${constant.type}`, [
            bytes,
          ]);
          assert.equal(expected.encodedLength, bytes.length);
          assert.equal(nativeHex(expected.toU8a()), constant.value);
          const response = await queryNativeRuntime(
            {
              as_of: at,
              operations: [
                {
                  kind: "constant",
                  pallet: pallet.name,
                  member: constant.name,
                },
              ],
            },
            rpc,
          );
          assert.deepEqual(response.results[0]!.value, decoded);
          constants++;
        }
        for (const item of pallet.storage) {
          const keys =
            item.key === null
              ? []
              : item.hashers.length === 1
                ? [item.key]
                : (() => {
                    const key = model.types.get(item.key!)!.definition;
                    assert.equal(key.kind, "tuple");
                    return key.kind === "tuple" ? key.types : [];
                  })();
          const args = keys.map((id) => sampleNativeValue(model, id));
          const expectedArgs = keys.map((id, index) =>
            registry.createTypeUnsafe(`Lookup${id}`, [
              encodeNativeValue(model, id, args[index]!),
            ]),
          );
          const fn =
            storageReference[stringCamelCase(pallet.name)]![
              stringCamelCase(item.name)
            ]!;
          const key = nativeStorageKey(model, pallet.prefix, item, args);
          assert.equal(
            key,
            registry.createType("StorageKey", fn(...expectedArgs)).toHex(),
            `${pallet.name}.${item.name}`,
          );
          for (let length = 0; length < args.length; length++) {
            assert.equal(
              nativeStorageKey(
                model,
                pallet.prefix,
                item,
                args.slice(0, length),
                true,
              ),
              nativeHex(fn.keyPrefix(...expectedArgs.slice(0, length))),
            );
            prefixes++;
          }
          const value = sampleNativeValue(model, item.value);
          const bytes = encodeNativeValue(model, item.value, value);
          const independent = registry.createTypeUnsafe(`Lookup${item.value}`, [
            bytes,
          ]);
          assert.equal(independent.encodedLength, bytes.length);
          assert.equal(nativeHex(independent.toU8a()), nativeHex(bytes));
          values.set(key, nativeHex(bytes));
          const response = await queryNativeRuntime(
            {
              as_of: at,
              operations: [
                {
                  kind: "storage",
                  pallet: pallet.name,
                  member: item.name,
                  args,
                },
              ],
            },
            rpc,
          );
          assert.deepEqual(
            response.results[0]!.value,
            decodeNativeValue(model, item.value, nativeHex(bytes)),
          );
          storage++;
        }
        if (pallet.calls === null) continue;
        const definition = model.types.get(pallet.calls)!.definition;
        assert.equal(definition.kind, "variant");
        if (definition.kind !== "variant") continue;
        for (const call of definition.variants) {
          let args: NativeValue[];
          try {
            args = call.fields.map((field) =>
              sampleNativeValue(model, field.type),
            );
          } catch (error) {
            if (!(error instanceof UninhabitedType)) throw error;
            assert.equal(pallet.name, "Grandpa");
            assert.match(call.name, /^report_equivocation/);
            assert.throws(
              () => encodeNativeValue(model, error.id, { variant: "Void", fields: {} }),
              /Invalid native enum variant/,
            );
            voidCalls.push(`${pallet.name}.${call.name}`);
            continue;
          }
          const response = await queryNativeRuntime(
            {
              as_of: at,
              operations: [
                {
                  kind: "prepare",
                  pallet: pallet.name,
                  member: call.name,
                  args,
                },
              ],
            },
            rpc,
          );
          assert.equal(response.source.runtime_spec_version, era.spec);
          assert.equal(response.source.metadata_version, version);
          const data = response.results[0]!.call_data!;
          const independent = registry.createType(
            "Call",
            Buffer.from(data.slice(2), "hex"),
          );
          assert.deepEqual(
            [...independent.callIndex],
            [pallet.index, call.index],
          );
          assert.equal(nativeHex(independent.toU8a()), data);
          assert.equal(independent.encodedLength, (data.length - 2) / 2);
          prepared++;
        }
      }
      assert.equal(calls.length, storage);
      assert.ok(constants > 0 && storage > 0 && prepared > 0);
      console.log(
        "NATIVE_LEGACY_ERA_CONTRACT",
        JSON.stringify({
          tag: era.tag,
          spec: era.spec,
          version,
          constants,
          storage,
          prefixes,
          prepared,
          voidCalls,
          execution_rpcs: 0,
          fixture: true,
          production: false,
        }),
      );
    }, 180000);
  }

  test(`compiled ${era.tag} spec ${era.spec} preserves every audited typed read API ABI`, async () => {
    const model = decodeNativeMetadata(unwrapNativeMetadata(era.v15)!);
    const registry = new TypeRegistry();
    registry.setMetadata(
      new Metadata(
        registry,
        Buffer.from(unwrapNativeMetadata(era.v15)!.slice(2), "hex"),
      ),
    );
    let executed = 0;
    let expectedMethod = "",
      expectedInput = "",
      expectedOutput = "";
    const rpc: BasketRpc = async (method, params) => {
      if (method === "chain_getFinalizedHead") return at;
      if (method === "chain_getHeader") return { number: "0x1f4" };
      if (method === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
      if (method === "state_getRuntimeVersion") return era.runtimeVersion;
      if (method === "state_getStorageHash")
        return `0x${createHash("sha256").update(`${era.wasm_sha256}:15`).digest("hex")}`;
      assert.equal(method, "state_call");
      if (params[0] === "Metadata_metadata_at_version") return era.v15;
      assert.deepEqual(params, [expectedMethod, expectedInput, at]);
      executed++;
      return expectedOutput;
    };
    rpc.batch = (rows) =>
      Promise.all(rows.map((row) => rpc(row.method, row.params)));
    const methods: string[] = [],
      opaque: string[] = [];
    for (const api of model.apis) {
      const allowed = pureApis.has(api.name)
        ? api.methods.map((method) => method.name)
        : Object.hasOwn(SCALE_READ_API_METHODS, api.name)
          ? SCALE_READ_API_METHODS[api.name]!
          : [];
      for (const method of api.methods) {
        if (!allowed.includes(method.name)) continue;
        const args = method.inputs.map((field) =>
          sampleNativeValue(model, field.type),
        );
        const input = method.inputs.map((field, index) =>
          encodeNativeValue(model, field.type, args[index]!),
        );
        for (let index = 0; index < input.length; index++) {
          const bytes = input[index]!;
          const independent = registry.createTypeUnsafe(
            `Lookup${method.inputs[index]!.type}`,
            [bytes],
          );
          assert.equal(independent.encodedLength, bytes.length);
          assert.equal(nativeHex(independent.toU8a()), nativeHex(bytes));
        }
        const bytes = encodeNativeValue(
          model,
          method.output,
          sampleNativeValue(model, method.output),
        );
        const independent = registry.createTypeUnsafe(
          `Lookup${method.output}`,
          [bytes],
        );
        assert.equal(independent.encodedLength, bytes.length);
        expectedMethod = `${api.name}_${method.name}`;
        expectedInput = nativeHex(Buffer.concat(input));
        expectedOutput = nativeHex(independent.toU8a());
        const response = await queryNativeRuntime(
          {
            operations: [
              { kind: "runtime", api: api.name, member: method.name, args },
            ],
          },
          rpc,
        );
        assert.deepEqual(
          response.results[0]!.value,
          decodeNativeValue(model, method.output, expectedOutput),
        );
        methods.push(expectedMethod);
        const output = model.types.get(method.output)!.definition;
        if (output.kind === "sequence") {
          const element = model.types.get(output.type)!.definition;
          if (element.kind === "primitive" && element.primitive === 3)
            opaque.push(expectedMethod);
        }
      }
    }
    assert.equal(executed, methods.length);
    assert.ok(methods.includes("AccountNonceApi_account_nonce"));
    for (const [api, member] of [
      ["Core", "execute_block"],
      ["BlockBuilder", "apply_extrinsic"],
      ["SessionKeys", "generate_session_keys"],
      ["TaggedTransactionQueue", "validate_transaction"],
    ]) {
      await assert.rejects(
        queryNativeRuntime(
          { operations: [{ kind: "runtime", api, member, args: [] }] },
          rpc,
        ),
        /not an audited read/,
      );
    }
    assert.equal(executed, methods.length);
    console.log(
      "NATIVE_LEGACY_ERA_APIS",
      JSON.stringify({
        tag: era.tag,
        spec: era.spec,
        methods,
        opaque,
        fixture: true,
        production: false,
      }),
    );
  }, 180000);
}
