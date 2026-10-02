import type { z } from "zod";
import type { NativeRuntimeRequestSchema } from "../schemas-src/routes/native-runtime.ts";
import type { NativeMetadata, NativeField } from "./native-runtime-metadata.ts";
import { encodeNativeValue, nativeHex } from "./native-runtime-values.ts";
import { encodeRuntimeEvmCall } from "./evm-runtime-abi.ts";

type Operation = z.infer<
  typeof NativeRuntimeRequestSchema
>["operations"][number];

/** Bind ABI bytes only into the runtime's declared call input. All remaining
 * arguments, including gas and value, go through the existing native planner. */
export function resolveNativeEvmCall(
  metadata: NativeMetadata,
  spec: number,
  operation: Extract<Operation, { kind: "runtime" | "prepare" }>,
) {
  if (!operation.evm_call) return { operation };
  let fields: NativeField[], target: string, input: string;
  if (
    operation.kind === "runtime" &&
    operation.api === "EthereumRuntimeRPCApi" &&
    operation.member === "call"
  ) {
    const api = metadata.apis.find((row) => row.name === operation.api);
    const method = api?.methods.find((row) => row.name === operation.member);
    if (!method) throw new Error("EVM call signature is absent at this source");
    fields = method.inputs;
    target = "to";
    input = "data";
  } else if (
    operation.kind === "prepare" &&
    operation.pallet === "EVM" &&
    operation.member === "call"
  ) {
    const pallet = metadata.pallets.find(
      (row) => row.name === operation.pallet,
    );
    const calls =
      pallet?.calls === null
        ? undefined
        : metadata.types.get(pallet?.calls ?? -1)?.definition;
    const call =
      calls?.kind === "variant"
        ? calls.variants.find((row) => row.name === operation.member)
        : undefined;
    if (!call) throw new Error("EVM call signature is absent at this source");
    fields = call.fields;
    target = "target";
    input = "input";
  } else
    throw new Error(
      "EVM ABI requires runtime call or native EVM.call preparation",
    );
  if (operation.args.length !== fields.length)
    throw new Error("EVM call argument arity mismatch");
  const targetFields = fields.flatMap((field, index) =>
    field.name === target ? [index] : [],
  );
  const inputFields = fields.flatMap((field, index) =>
    field.name === input ? [index] : [],
  );
  if (targetFields.length !== 1 || inputFields.length !== 1)
    throw new Error("EVM requires one declared target and input");
  const index = inputFields[0]!;
  const type = metadata.types.get(fields[index]!.type)?.definition;
  const item =
    type?.kind === "sequence"
      ? metadata.types.get(type.type)?.definition
      : undefined;
  if (item?.kind !== "primitive" || item.primitive !== 3)
    throw new Error("EVM input is not a declared byte vector");
  if (operation.args[index] !== "0x")
    throw new Error("EVM ABI requires an empty input argument");
  const address = nativeHex(
    encodeNativeValue(
      metadata,
      fields[targetFields[0]!]!.type,
      operation.args[targetFields[0]!]!,
    ),
  );
  const encoded = encodeRuntimeEvmCall(
    spec,
    address,
    operation.evm_call.signature,
    operation.evm_call.args,
  );
  const args = operation.args.slice();
  args[index] = encoded.input;
  return { operation: { ...operation, args }, contract: encoded };
}
