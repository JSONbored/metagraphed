import assert from "node:assert/strict";
import { test } from "vitest";
import { NativeRuntimeRequestSchema } from "../schemas-src/routes/native-runtime.ts";
import { resolveNativeEvmCall } from "../src/native-evm-call.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeMetadata,
  type NativeField,
} from "../src/native-runtime-metadata.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import wrapped from "./fixtures/native-v470-compiled.ts";

const model = decodeNativeMetadata(unwrapNativeMetadata(wrapped)!);
const to = `0x${(2053).toString(16).padStart(40, "0")}`;
const evm_call = {
  signature: "getStake(bytes32,bytes32,uint256)",
  args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "19"],
};
const api = model.apis.find((row) => row.name === "EthereumRuntimeRPCApi")!;
const method = api.methods.find((row) => row.name === "call")!;
function operation() {
  return NativeRuntimeRequestSchema.parse({
    operations: [
      {
        kind: "runtime",
        api: api.name,
        member: method.name,
        args: method.inputs.map((field) =>
          field.name === "to"
            ? to
            : field.name === "data"
              ? "0x"
              : sampleNativeValue(model, field.type),
        ),
        evm_call,
      },
    ],
  }).operations[0] as Extract<
    ReturnType<typeof NativeRuntimeRequestSchema.parse>["operations"][number],
    { kind: "runtime" }
  >;
}
function fieldsModel(fields: NativeField[]): NativeMetadata {
  return {
    ...model,
    apis: [{ ...api, methods: [{ ...method, inputs: fields }] }],
  };
}
test("ABI binding preserves original args, type-checks the declared target and accepts only empty byte input", () => {
  const op = operation();
  const resolved = resolveNativeEvmCall(model, 470, op);
  const index = method.inputs.findIndex((field) => field.name === "data");
  assert.equal(op.args[index], "0x");
  assert.ok(String(resolved.operation.args[index]).startsWith("0xe3b598fa"));
  assert.equal(resolved.contract!.address, to);
  assert.equal(Object.hasOwn(resolved.contract!, "input"), false);
  assert.equal(
    resolveNativeEvmCall(model, 470, { ...op, evm_call: undefined }).operation
      .args,
    op.args,
  );
  assert.throws(
    () => resolveNativeEvmCall(model, 470, { ...op, member: "create" }),
    /requires runtime call/,
  );
  assert.throws(
    () => resolveNativeEvmCall({ ...model, apis: [] }, 470, op),
    /absent/,
  );
  assert.throws(
    () =>
      resolveNativeEvmCall(
        { ...model, apis: [{ ...api, methods: [] }] },
        470,
        op,
      ),
    /absent/,
  );
  assert.throws(
    () => resolveNativeEvmCall(model, 470, { ...op, args: [] }),
    /arity/,
  );
  for (const field of ["to", "data"]) {
    const original = method.inputs.find((row) => row.name === field)!;
    assert.throws(
      () =>
        resolveNativeEvmCall(
          fieldsModel(
            method.inputs.map((row) =>
              row === original ? { ...row, name: "other" } : row,
            ),
          ),
          470,
          op,
        ),
      /one declared/,
    );
    assert.throws(
      () =>
        resolveNativeEvmCall(fieldsModel([...method.inputs, original]), 470, {
          ...op,
          args: [...op.args, op.args[0]!],
        }),
      /one declared/,
    );
  }
  const wrongTypes = method.inputs.map((row) =>
    row.name === "data" ? { ...row, type: method.inputs[0]!.type } : row,
  );
  assert.throws(
    () => resolveNativeEvmCall(fieldsModel(wrongTypes), 470, op),
    /byte vector/,
  );
  const sequence = method.inputs.find((row) => row.name === "data")!.type;
  const sequenceDef = model.types.get(sequence)!.definition;
  assert.equal(sequenceDef.kind, "sequence");
  if (sequenceDef.kind !== "sequence") return;
  const types = new Map(model.types);
  types.delete(sequenceDef.type);
  assert.throws(
    () => resolveNativeEvmCall({ ...model, types }, 470, op),
    /byte vector/,
  );
  assert.throws(
    () =>
      resolveNativeEvmCall(model, 470, {
        ...op,
        args: op.args.map((v, i) => (i === index ? "0x00" : v)),
      }),
    /empty input/,
  );
  assert.throws(() => resolveNativeEvmCall(model, 471, op), /not qualified/);
  const prepare = { ...op, kind: "prepare" as const, pallet: "EVM" };
  assert.throws(
    () => resolveNativeEvmCall({ ...model, pallets: [] }, 470, prepare),
    /absent/,
  );
  const pallet = model.pallets.find((row) => row.name === "EVM")!;
  assert.throws(
    () =>
      resolveNativeEvmCall(
        { ...model, pallets: [{ ...pallet, calls: null }] },
        470,
        prepare,
      ),
    /absent/,
  );
  const calls = model.types.get(pallet.calls!)!.definition;
  assert.equal(calls.kind, "variant");
  if (calls.kind !== "variant") return;
  const missing = new Map(model.types);
  missing.set(pallet.calls!, {
    ...model.types.get(pallet.calls!)!,
    definition: { ...calls, variants: [] },
  });
  assert.throws(
    () => resolveNativeEvmCall({ ...model, types: missing }, 470, prepare),
    /absent/,
  );
  assert.throws(
    () => resolveNativeEvmCall(model, 470, { ...prepare, member: "create" }),
    /requires runtime call/,
  );
});
