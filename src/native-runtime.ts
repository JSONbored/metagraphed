import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NativeRuntimeRequestSchema,
  NativeRuntimeArtifactSchema,
  NativeRuntimeSourceSchema,
} from "../schemas-src/routes/native-runtime.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeType,
} from "./native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeStorageKey,
  nativeHex,
  type NativeValue,
} from "./native-runtime-values.ts";
import { rootBasketRpc } from "./root-basket-rpc.ts";
import { basketReadBatch, type BasketRpc } from "./root-basket-runtime.ts";
import {
  CHAIN_NAME_BY_NETWORK,
  chainNetworkFromChainName,
  type ChainNetworkId,
} from "./chain-network.ts";

const header = z.object({
  number: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .max(18),
});
const version = z.object({
  specName: z.literal("node-subtensor"),
  specVersion: z.int().nonnegative(),
  transactionVersion: z.int().nonnegative(),
});
const blockHash = NativeRuntimeSourceSchema.shape.finalized_block_hash;
type Operation = z.infer<
  typeof NativeRuntimeRequestSchema
>["operations"][number];
// Metadata also describes node-internal APIs that can execute a block or write
// a keystore. Only these audited read API families may reach state_call.
const READ_APIS = new Set([
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
function readApiMethod(api: string, member: string) {
  return (
    READ_APIS.has(api) ||
    (api === "Core" && member === "version") ||
    (api === "ContractsApi" && member === "get_storage") ||
    (api === "ShieldApi" &&
      ["try_decode_shielded_tx", "is_shielded_using_current_key"].includes(
        member,
      ))
  );
}

function contract(
  metadata: NativeMetadata,
  root: number,
  needed: Map<number, NativeType>,
) {
  const pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    if (needed.has(id)) continue;
    if (needed.size >= NATIVE_RUNTIME_LIMITS.types)
      throw new Error("Native contract exceeds work budget");
    const type = metadata.types.get(id);
    if (!type) throw new Error("Missing native portable type");
    needed.set(id, type);
    const def = type.definition;
    if (def.kind === "composite")
      pending.push(...def.fields.map((field) => field.type));
    else if (def.kind === "variant")
      pending.push(
        ...def.variants.flatMap((variant) =>
          variant.fields.map((field) => field.type),
        ),
      );
    else if (def.kind === "tuple") pending.push(...def.types);
    else if (def.kind === "bits") {
      pending.push(def.store, def.order);
    } else if (def.kind !== "primitive") pending.push(def.type);
  }
  return { root_type: root };
}
function plan(
  metadata: NativeMetadata,
  operation: Operation,
  needed: Map<number, NativeType>,
) {
  if (operation.kind === "describe") {
    if (
      [operation.pallet, operation.api, operation.type_id].filter(
        (value) => value !== undefined,
      ).length > 1
    )
      throw new Error(
        "Describe one pallet, runtime API or portable type at a time",
      );
    if (operation.type_id !== undefined)
      return {
        result: {
          kind: "describe" as const,
          contract: contract(metadata, operation.type_id, needed),
        },
      };
    let items: NativeValue[];
    if (operation.pallet !== undefined) {
      const pallet = metadata.pallets.find(
        (row) => row.name === operation.pallet,
      );
      if (!pallet) throw new Error("Unknown native pallet");
      const calls =
        pallet.calls === null
          ? []
          : metadata.types.get(pallet.calls)?.definition;
      items = [
        ...pallet.storage.map((item) => ({
          kind: "storage",
          pallet: pallet.name,
          member: item.name,
          key_type: item.key,
          key_parts: item.hashers.length,
          value_type: item.value,
          optional: item.optional,
        })),
        ...pallet.constants.map((item) => ({
          kind: "constant",
          pallet: pallet.name,
          member: item.name,
          value_type: item.type,
        })),
        ...(Array.isArray(calls)
          ? []
          : calls?.kind === "variant"
            ? calls.variants.map((call) => ({
                kind: "prepare",
                pallet: pallet.name,
                member: call.name,
                args: call.fields.map((field) => ({ ...field })),
              }))
            : []),
      ];
    } else if (operation.api !== undefined) {
      const api = metadata.apis.find((row) => row.name === operation.api);
      if (!api) throw new Error("Unknown native runtime API");
      items = api.methods
        .filter((method) => readApiMethod(api.name, method.name))
        .map((method) => ({
          kind: "runtime",
          api: api.name,
          member: method.name,
          args: method.inputs.map((field) => ({ ...field })),
          value_type: method.output,
        }));
    } else
      items = [
        ...metadata.pallets.map((row) => ({ kind: "pallet", name: row.name })),
        ...metadata.apis
          .filter((row) =>
            row.methods.some((method) => readApiMethod(row.name, method.name)),
          )
          .map((row) => ({ kind: "api", name: row.name })),
      ];
    const page = items.slice(
      operation.offset,
      operation.offset + operation.limit,
    );
    for (const item of page) {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        continue;
      for (const key of ["key_type", "value_type"])
        if (typeof item[key] === "number")
          contract(metadata, item[key], needed);
      if (Array.isArray(item.args))
        for (const field of item.args)
          if (
            field !== null &&
            typeof field === "object" &&
            !Array.isArray(field) &&
            typeof field.type === "number"
          )
            contract(metadata, field.type, needed);
    }
    return {
      result: {
        kind: "describe" as const,
        value: page,
        contract: {
          total: items.length,
          next_offset:
            operation.offset + operation.limit < items.length
              ? operation.offset + operation.limit
              : null,
        },
      },
    };
  }
  if (operation.kind === "runtime") {
    if (!readApiMethod(operation.api, operation.member))
      throw new Error("Native runtime method is not an audited read");
    const api = metadata.apis.find((row) => row.name === operation.api);
    const method = api?.methods.find((row) => row.name === operation.member);
    if (!method) throw new Error("Unknown native runtime method");
    if (operation.args.length !== method.inputs.length)
      throw new Error("Native runtime argument arity mismatch");
    const input = Buffer.concat(
      method.inputs.map((field, index) =>
        encodeNativeValue(metadata, field.type, operation.args[index]!),
      ),
    );
    if (input.length > NATIVE_RUNTIME_LIMITS.valueBytes)
      throw new Error("Native runtime input exceeds byte budget");
    return {
      call: {
        method: "state_call",
        params: [`${operation.api}_${method.name}`, nativeHex(input)],
      },
      result: {
        kind: "runtime" as const,
        api: operation.api,
        member: method.name,
        contract: contract(metadata, method.output, needed),
      },
      output: method.output,
    };
  }
  const pallet = metadata.pallets.find((row) => row.name === operation.pallet);
  if (!pallet) throw new Error("Unknown native pallet");
  if (operation.kind === "constant") {
    const item = pallet.constants.find((row) => row.name === operation.member);
    if (!item) throw new Error("Unknown native constant");
    return {
      result: {
        kind: "constant" as const,
        pallet: pallet.name,
        member: item.name,
        value: decodeNativeValue(metadata, item.type, item.value),
        contract: contract(metadata, item.type, needed),
      },
    };
  }
  if (operation.kind === "prepare") {
    const calls =
      pallet.calls === null
        ? undefined
        : metadata.types.get(pallet.calls)?.definition;
    const call =
      calls?.kind === "variant"
        ? calls.variants.find((row) => row.name === operation.member)
        : undefined;
    if (!call) throw new Error("Unknown native extrinsic");
    if (operation.args.length !== call.fields.length)
      throw new Error("Native call argument arity mismatch");
    metadata.signedExtensions.forEach((extension) => {
      contract(metadata, extension.type, needed);
      contract(metadata, extension.additional, needed);
    });
    const input = Buffer.concat([
      Buffer.from([pallet.index, call.index]),
      ...call.fields.map((field, index) =>
        encodeNativeValue(metadata, field.type, operation.args[index]!),
      ),
    ]);
    if (input.length > NATIVE_RUNTIME_LIMITS.valueBytes)
      throw new Error("Native call exceeds byte budget");
    return {
      result: {
        kind: "prepare" as const,
        pallet: pallet.name,
        member: call.name,
        call_data: nativeHex(input),
        contract: {
          extrinsic_version: metadata.extrinsicVersion,
          signed_extensions: metadata.signedExtensions,
          args: call.fields.map((field) => ({
            name: field.name,
            ...contract(metadata, field.type, needed),
          })),
        },
      },
    };
  }
  const item = pallet.storage.find((row) => row.name === operation.member);
  if (!item) throw new Error("Unknown native storage item");
  const key = nativeStorageKey(metadata, pallet.prefix, item, operation.args);
  return {
    call: { method: "state_getStorage", params: [key] },
    item,
    output: item.value,
    result: {
      kind: "storage" as const,
      pallet: pallet.name,
      member: item.name,
      storage_key: key,
      contract: contract(metadata, item.value, needed),
    },
  };
}

/** One finalized context for a bounded batch; validate every operation before
 * issuing state reads. Identical calls are coalesced, then restored in order. */
export async function queryNativeRuntime(raw: unknown, rpc?: BasketRpc) {
  const input = NativeRuntimeRequestSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(input)) > 32_768)
    throw new Error("Native request exceeds byte budget");
  const network: ChainNetworkId = chainNetworkFromChainName(input.network);
  const read = rpc ?? rootBasketRpc(network);
  const finalized = blockHash.parse(await read("chain_getFinalizedHead", []));
  const at = input.as_of ?? finalized;
  const [rawHeader, rawVersion, genesis] = await basketReadBatch(read, [
    { method: "chain_getHeader", params: [at] },
    { method: "state_getRuntimeVersion", params: [at] },
    { method: "chain_getBlockHash", params: [0] },
  ]);
  const height = BigInt(header.parse(rawHeader).number),
    runtime = version.parse(rawVersion);
  if (at !== finalized) {
    const [finalizedHeader, canonical] = await basketReadBatch(read, [
      { method: "chain_getHeader", params: [finalized] },
      { method: "chain_getBlockHash", params: [`0x${height.toString(16)}`] },
    ]);
    if (
      height > BigInt(header.parse(finalizedHeader).number) ||
      blockHash.parse(canonical) !== at
    )
      throw new Error("Native as_of must be a canonical finalized ancestor");
  }
  let metadataHex: string | null;
  try {
    metadataHex = unwrapNativeMetadata(
      await read("state_call", [
        "Metadata_metadata_at_version",
        "0x0f000000",
        at,
      ]),
    );
  } catch {
    metadataHex = null;
  }
  if (metadataHex === null) {
    const fallback = await read("state_getMetadata", [at]);
    const reader = new NativeScaleReader(
      fallback,
      NATIVE_RUNTIME_LIMITS.metadataBytes,
    );
    metadataHex = nativeHex(reader.bytes);
  }
  const metadata = decodeNativeMetadata(metadataHex);
  const source = NativeRuntimeSourceSchema.parse({
    network: CHAIN_NAME_BY_NETWORK[network],
    network_genesis_hash: genesis,
    finalized_block_hash: at,
    finalized_block: height.toString(),
    runtime_spec_version: runtime.specVersion,
    runtime_transaction_version: runtime.transactionVersion,
    metadata_version: metadata.version,
    metadata_sha256: `0x${createHash("sha256")
      .update(Buffer.from(metadataHex.slice(2), "hex"))
      .digest("hex")}`,
  });
  const needed = new Map<number, NativeType>();
  const plans = input.operations.map((operation) =>
    plan(metadata, operation, needed),
  );
  const unique = new Map<string, { method: string; params: unknown[] }>();
  const callKeys = plans.map((row) => {
    if (!("call" in row) || !row.call) return null;
    const call = { method: row.call.method, params: [...row.call.params, at] };
    const key = JSON.stringify(call);
    unique.set(key, call);
    return key;
  });
  const calls = [...unique.entries()];
  const values =
    calls.length === 0
      ? []
      : await basketReadBatch(
          read,
          calls.map(([, call]) => call),
        );
  const responses = new Map(calls.map(([key], index) => [key, values[index]]));
  const results = plans.map((row, index) => {
    const key = callKeys[index];
    if (key === null || key === undefined) return row.result;
    let value = responses.get(key),
      isDefault = false;
    if ("item" in row && row.item && value === null) {
      if (row.item.optional)
        return { ...row.result, value: null, is_default: false };
      value = row.item.fallback;
      isDefault = true;
    }
    if (!("output" in row) || row.output === undefined)
      throw new Error("Missing native result contract");
    return {
      ...row.result,
      value: decodeNativeValue(metadata, row.output, value),
      ...("item" in row ? { is_default: isDefault } : {}),
    };
  });
  const output = NativeRuntimeArtifactSchema.parse({
    schema_version: 1,
    source,
    types: [...needed.values()],
    results,
  });
  if (Buffer.byteLength(JSON.stringify(output)) > 524_288)
    throw new Error("Native response exceeds byte budget");
  return output;
}
