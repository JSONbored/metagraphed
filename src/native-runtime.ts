import { z } from "zod";
import {
  NativeRuntimeRequestSchema,
  NativeRuntimeArtifactSchema,
  NativeRuntimeSourceSchema,
} from "../schemas-src/routes/native-runtime.ts";
import {
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeType,
  type NativeField,
} from "./native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeStorageKey,
  nativeHex,
  nativeStorageEntryKeys,
  type NativeValue,
} from "./native-runtime-values.ts";
import { nativeRuntimeRpc } from "./native-runtime-rpc.ts";
import { loadNativeContract } from "./native-runtime-contract.ts";
import {
  nativeContractSimulationWork,
  assertNativeContractSimulationBudget,
} from "./native-contract-simulation.ts";
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
// Audited against Subtensor v470's runtime implementations. These APIs mix
// reads with block execution, unsigned submission or local keystore writes,
// so admission is per method. Ethereum call/create use the official runtime
// Runner with is_transactional=false, at one finalized state, with an aggregate
// gas budget. They simulate execution and never submit a transaction.
const READ_API_METHODS: Readonly<Record<string, readonly string[]>> = {
  Core: ["version"],
  Metadata: ["metadata", "metadata_at_version", "metadata_versions"],
  AuraApi: ["slot_duration", "authorities"],
  BabeApi: [
    "configuration",
    "current_epoch_start",
    "current_epoch",
    "next_epoch",
    "generate_key_ownership_proof",
  ],
  GrandpaApi: [
    "grandpa_authorities",
    "current_set_id",
    "generate_key_ownership_proof",
  ],
  SessionKeys: ["decode_session_keys"],
  GenesisBuilder: ["get_preset", "preset_names"],
  EthereumRuntimeRPCApi: [
    "chain_id",
    "account_basic",
    "gas_price",
    "account_code_at",
    "author",
    "storage_at",
    "call",
    "create",
    "current_transaction_statuses",
    "current_block",
    "current_receipts",
    "current_all",
    "extrinsic_filter",
    "elasticity",
    "gas_limit_multiplier_support",
  ],
  ConvertTransactionRuntimeApi: ["convert_transaction"],
  ContractsApi: ["call", "instantiate", "upload_code", "get_storage"],
  ShieldApi: ["try_decode_shielded_tx", "is_shielded_using_current_key"],
};
export const NATIVE_EVM_SIMULATION_GAS_BUDGET = 1_000_000n;

function readApiMethod(api: string, member: string) {
  return (
    READ_APIS.has(api) ||
    (Object.hasOwn(READ_API_METHODS, api) &&
      READ_API_METHODS[api]!.includes(member))
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
    let items: {
      kind: string;
      name?: string;
      pallet?: string;
      api?: string;
      member?: string;
      key_type?: number | null;
      key_parts?: number;
      value_type?: number;
      optional?: boolean;
      args?: NativeField[];
    }[];
    if (operation.pallet !== undefined) {
      const pallet = metadata.pallets.find(
        (row) => row.name === operation.pallet,
      );
      if (!pallet) throw new Error("Unknown native pallet");
      const calls =
        pallet.calls === null
          ? undefined
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
        ...(calls?.kind === "variant"
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
      for (const key of ["key_type", "value_type"] as const)
        if (typeof item[key] === "number")
          contract(metadata, item[key], needed);
      for (const field of item.args ?? [])
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
    let simulationGas = 0n;
    if (
      operation.api === "EthereumRuntimeRPCApi" &&
      (operation.member === "call" || operation.member === "create")
    ) {
      const gasFields = method.inputs.flatMap((field, index) =>
        field.name === "gas_limit" ? [index] : [],
      );
      if (gasFields.length !== 1)
        throw new Error("EVM simulation requires a declared gas_limit");
      const gas = operation.args[gasFields[0]!]!;
      if (!(
        (typeof gas === "string" && /^(0|[1-9]\d*)$/.test(gas)) ||
        (typeof gas === "number" && Number.isSafeInteger(gas) && gas >= 0)
      ))
        throw new Error(
          "EVM simulation gas must be an exact nonnegative integer",
        );
      simulationGas = BigInt(gas);
      if (
        simulationGas === 0n ||
        simulationGas > NATIVE_EVM_SIMULATION_GAS_BUDGET
      )
        throw new Error("EVM simulation exceeds its gas budget");
    }
    const input = Buffer.concat(
      method.inputs.map((field, index) =>
        encodeNativeValue(metadata, field.type, operation.args[index]!),
      ),
    );
    if (input.length > NATIVE_RUNTIME_LIMITS.valueBytes)
      throw new Error("Native runtime input exceeds byte budget");
    // The node's state_call executor uses a fresh, discarded overlay. These
    // official contract APIs simulate execution; no author/submission RPC is
    // reachable. Bound Weight and code work before issuing any execution RPC.
    const contractWork = operation.api === "ContractsApi" && operation.member !== "get_storage"
      ? nativeContractSimulationWork(operation.member, method.inputs, operation.args)
      : null;
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
      simulationGas,
      contractWork,
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
  if (operation.kind === "entries") {
    if (item.key === null)
      throw new Error("Native entries require a storage map");
    const prefix = nativeStorageKey(
      metadata,
      pallet.prefix,
      item,
      operation.args,
      true,
    );
    if (operation.cursor !== undefined) {
      if (!operation.cursor.startsWith(prefix))
        throw new Error("Native entries cursor must belong to this map prefix");
      nativeStorageEntryKeys(metadata, pallet.prefix, item, operation.cursor);
    }
    contract(metadata, item.key, needed);
    return {
      call: {
        method: "state_getKeysPaged",
        params: [prefix, operation.limit + 1, operation.cursor ?? null],
      },
      entry: {
        prefix,
        palletPrefix: pallet.prefix,
        item,
        limit: operation.limit,
        cursor: operation.cursor,
      },
      result: {
        kind: "entries" as const,
        pallet: pallet.name,
        member: item.name,
        contract: {
          ...contract(metadata, item.value, needed),
          key_type: item.key,
          hashers: item.hashers,
          prefix,
        },
      },
    };
  }
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
  return readNativeRuntime(NativeRuntimeRequestSchema.parse(raw), rpc);
}

/** Internal entrypoint for callers that have already validated the canonical
 * request at their REST or MCP boundary. Do not clone and walk it a second time. */
export async function readNativeRuntime(
  input: z.infer<typeof NativeRuntimeRequestSchema>,
  rpc?: BasketRpc,
) {
  if (Buffer.byteLength(JSON.stringify(input)) > 32_768)
    throw new Error("Native request exceeds byte budget");
  if (
    input.operations.reduce(
      (total, op) => total + (op.kind === "entries" ? op.limit : 0),
      0,
    ) > 64
  )
    throw new Error("Native entries exceed the aggregate page budget");
  if (
    input.operations.some(
      (op) => op.kind === "entries" && op.cursor !== undefined,
    ) &&
    input.as_of === undefined
  )
    throw new Error(
      "Native entries continuation requires its finalized as_of hash",
    );
  const network: ChainNetworkId = chainNetworkFromChainName(input.network);
  const read = rpc ?? nativeRuntimeRpc(network);
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
  const { metadata, sha256, codeHash } = await loadNativeContract(
    read,
    at,
    blockHash.parse(genesis),
    runtime.specVersion,
    runtime.transactionVersion,
  );
  const source = NativeRuntimeSourceSchema.parse({
    network: CHAIN_NAME_BY_NETWORK[network],
    network_genesis_hash: genesis,
    finalized_block_hash: at,
    finalized_block: height.toString(),
    runtime_spec_version: runtime.specVersion,
    runtime_transaction_version: runtime.transactionVersion,
    metadata_version: metadata.version,
    metadata_sha256: sha256,
    runtime_code_hash: codeHash,
  });
  const needed = new Map<number, NativeType>();
  const plans = input.operations.map((operation) =>
    plan(metadata, operation, needed),
  );
  const unique = new Map<string, { method: string; params: unknown[] }>();
  const executionGas = new Map<string, bigint>();
  const contractWork = new Map<string, ReturnType<typeof nativeContractSimulationWork>>();
  const callKeys = plans.map((row) => {
    if (!("call" in row) || !row.call) return null;
    const call = { method: row.call.method, params: [...row.call.params, at] };
    const key = JSON.stringify(call);
    unique.set(key, call);
    if ("simulationGas" in row && row.simulationGas)
      executionGas.set(key, row.simulationGas);
    if ("contractWork" in row && row.contractWork)
      contractWork.set(key, row.contractWork);
    return key;
  });
  if (
    [...executionGas.values()].reduce((total, gas) => total + gas, 0n) >
    NATIVE_EVM_SIMULATION_GAS_BUDGET
  )
    throw new Error("EVM simulations exceed the aggregate gas budget");
  assertNativeContractSimulationBudget(contractWork.values());
  const calls = [...unique.entries()];
  const values =
    calls.length === 0
      ? []
      : await basketReadBatch(
          read,
          calls.map(([, call]) => call),
        );
  const responses = new Map(calls.map(([key], index) => [key, values[index]]));
  const pages = new Map<
    number,
    { keys: string[]; decoded: Map<string, NativeValue[]>; next: string | null }
  >();
  const extra = new Map<string, { method: string; params: unknown[] }>();
  plans.forEach((row, index) => {
    if (!("entry" in row) || !row.entry) return;
    const page = responses.get(callKeys[index]!);
    if (!Array.isArray(page) || page.length > row.entry.limit + 1)
      throw new Error("Invalid native entries page");
    let previous = row.entry.cursor ?? "";
    const decoded = new Map<string, NativeValue[]>();
    for (const key of page) {
      if (
        typeof key !== "string" ||
        !/^0x(?:[0-9a-f]{2})+$/.test(key) ||
        !key.startsWith(row.entry.prefix) ||
        key <= previous ||
        key.length > 8194
      )
        throw new Error("Invalid native entries key order or prefix");
      decoded.set(
        key,
        nativeStorageEntryKeys(
          metadata,
          row.entry.palletPrefix,
          row.entry.item,
          key,
        ),
      );
      previous = key;
    }
    const keys = page.slice(0, row.entry.limit) as string[];
    pages.set(index, {
      keys,
      decoded,
      next: page.length > row.entry.limit ? keys.at(-1)! : null,
    });
    for (const key of keys) {
      const call = { method: "state_getStorage", params: [key, at] };
      const id = JSON.stringify(call);
      if (!responses.has(id)) extra.set(id, call);
    }
  });
  const entryReads = [...extra.entries()];
  for (let offset = 0; offset < entryReads.length; offset += 16) {
    const chunk = entryReads.slice(offset, offset + 16);
    const readValues = await basketReadBatch(
      read,
      chunk.map(([, call]) => call),
    );
    chunk.forEach(([key], index) => responses.set(key, readValues[index]));
  }
  const results = plans.map((row, index) => {
    if ("entry" in row && row.entry) {
      const entry = row.entry,
        page = pages.get(index)!;
      return {
        ...row.result,
        contract: { ...row.result.contract, next_cursor: page.next },
        value: page.keys.map((key) => {
          const value = responses.get(
            JSON.stringify({ method: "state_getStorage", params: [key, at] }),
          );
          if (value === null || value === undefined)
            throw new Error("Native enumerated storage value is absent");
          return {
            storage_key: key,
            keys: page.decoded.get(key)!,
            value: decodeNativeValue(metadata, entry.item.value, value),
          };
        }),
      };
    }
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
