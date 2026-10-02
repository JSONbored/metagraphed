import type { ApiSchema } from "@jsonbored/metagraphed";
import { decodeSs58 } from "./ss58";

export type NativeArtifact = ApiSchema<"NativeRuntimeArtifact">;
export type NativeRequest = ApiSchema<"NativeRuntimeRequest">;
export type NativeOperation = NativeRequest["operations"][number];
type Json = NonNullable<NativeArtifact["results"][number]["value"]> | null;

export const NATIVE_FEATURES = [
  { id: "mechanisms", label: "Mechanisms", account: false, hotkey: false },
  { id: "collateral", label: "Collateral policy", account: false, hotkey: false },
  { id: "hyperparameters", label: "Hyperparameters", account: false, hotkey: false },
  { id: "lock", label: "Account lock", account: true, hotkey: false },
  { id: "auto-stake", label: "Auto stake", account: true, hotkey: false },
  { id: "pending-children", label: "Pending delegation", account: false, hotkey: true },
  { id: "miner-collateral", label: "Miner collateral", account: true, hotkey: true },
  { id: "conviction", label: "Conviction and subnet king", account: false, hotkey: true },
] as const;
export type NativeFeature = (typeof NATIVE_FEATURES)[number]["id"];

export function accountHex(value: string): string {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  const account = decodeSs58(trimmed);
  if (!account?.checksumValid || !account.pubkey)
    throw new Error("Enter a valid SS58 address or 32-byte account public key.");
  return `0x${Array.from(account.pubkey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function featureOperations(
  feature: NativeFeature,
  netuidText: string,
  coldkey = "",
  hotkey = "",
): NativeOperation[] {
  if (!/^(0|[1-9]\d*)$/.test(netuidText) || Number(netuidText) > 65535)
    throw new Error("Enter a subnet number between 0 and 65535.");
  const netuid = Number(netuidText);
  const storage = (member: string, args: Json[] = [netuid]): NativeOperation => ({
    kind: "storage",
    pallet: "SubtensorModule",
    member,
    args,
  });
  const runtime = (api: string, member: string, args: Json[]): NativeOperation => ({
    kind: "runtime",
    api,
    member,
    args,
  });
  switch (feature) {
    case "mechanisms":
      return [storage("MechanismCountCurrent"), storage("MechanismEmissionSplit")];
    case "collateral":
      return [storage("CollateralLockShare"), storage("CollateralDrainRatio")];
    case "hyperparameters":
      return [
        runtime("SubnetInfoRuntimeApi", "get_subnet_hyperparams_v3", [netuid]),
        storage("LiquidAlphaConsensusMode"),
      ];
    case "lock":
      return [runtime("StakeInfoRuntimeApi", "get_coldkey_lock", [accountHex(coldkey), netuid])];
    case "auto-stake":
      return [
        runtime("SubnetInfoRuntimeApi", "get_coldkey_auto_stake_hotkey", [
          accountHex(coldkey),
          netuid,
        ]),
      ];
    case "pending-children":
      return [storage("PendingChildKeys", [netuid, accountHex(hotkey)])];
    case "miner-collateral":
      return [storage("MinerCollateral", [netuid, accountHex(hotkey), accountHex(coldkey)])];
    case "conviction":
      return [
        runtime("StakeInfoRuntimeApi", "get_hotkey_conviction", [accountHex(hotkey), netuid]),
        runtime("StakeInfoRuntimeApi", "get_most_convicted_hotkey_on_subnet", [netuid]),
      ];
  }
}

export interface NativeMember {
  kind: "storage" | "constant" | "runtime" | "runtime_scale" | "prepare";
  pallet?: string;
  api?: string;
  member: string;
  runtimeApiVersion?: number;
  args: { name: string | null; type: number }[];
}
export function describedMembers(artifact: NativeArtifact): NativeMember[] {
  const rows = artifact.results[0]?.value;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.member !== "string"
    )
      return [];
    if (!["storage", "constant", "runtime", "runtime_scale", "prepare"].includes(String(row.kind)))
      return [];
    const args: NativeMember["args"] = [];
    if (typeof row.key_type === "number") {
      const key = artifact.types.find((type) => type.id === row.key_type);
      const keys =
        row.key_parts !== 1 && key?.definition.kind === "tuple"
          ? key.definition.types
          : [row.key_type];
      keys.forEach((type, index) => args.push({ name: `key_${index + 1}`, type }));
    } else if (Array.isArray(row.args)) {
      for (const arg of row.args) {
        if (
          arg !== null &&
          typeof arg === "object" &&
          !Array.isArray(arg) &&
          typeof arg.type === "number"
        )
          args.push({ name: typeof arg.name === "string" ? arg.name : null, type: arg.type });
      }
    }
    return [
      {
        kind: row.kind as NativeMember["kind"],
        member: row.member,
        ...(typeof row.pallet === "string" ? { pallet: row.pallet } : {}),
        ...(typeof row.api === "string" ? { api: row.api } : {}),
        ...(typeof row.runtime_api_version === "number"
          ? { runtimeApiVersion: row.runtime_api_version }
          : {}),
        args,
      },
    ];
  });
}

export function supportsNativeCodeArtifact(
  member: Pick<NativeMember, "kind" | "api" | "pallet" | "member">,
) {
  return (
    (member.kind === "runtime" &&
      member.api === "ContractsApi" &&
      ["upload_code", "instantiate"].includes(member.member)) ||
    (member.kind === "prepare" &&
      member.pallet === "Contracts" &&
      ["upload_code", "instantiate_with_code"].includes(member.member)) ||
    (member.kind === "runtime" &&
      member.api === "EthereumRuntimeRPCApi" &&
      member.member === "create") ||
    (member.kind === "prepare" &&
      member.pallet === "EVM" &&
      ["create", "create2"].includes(member.member))
  );
}
export function codeArtifactOperation(
  operation: NativeOperation,
  url: string,
  sha256: string,
  bytes: string,
): NativeOperation {
  const fields = [url.trim(), sha256.trim(), bytes.trim()];
  if (fields.every((field) => !field)) return operation;
  if (
    (operation.kind !== "runtime" && operation.kind !== "prepare") ||
    !supportsNativeCodeArtifact(operation)
  )
    throw new Error("Choose a contract code upload or preparation operation.");
  const source = new URL(fields[0]!);
  if (
    source.protocol !== "https:" ||
    source.hostname !== "raw.githubusercontent.com" ||
    source.username ||
    source.password ||
    source.port ||
    source.search ||
    source.hash ||
    !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[^%?#\\]+$/.test(source.pathname)
  )
    throw new Error("Enter a public GitHub raw file URL pinned to a full commit.");
  if (!/^[0-9a-f]{64}$/.test(fields[1]!))
    throw new Error("Enter the artifact’s exact 64-character SHA-256.");
  if (!/^[1-9]\d*$/.test(fields[2]!) || Number(fields[2]) > 131072)
    throw new Error("Enter an artifact size from 1 through 131,072 bytes.");
  return {
    ...operation,
    code_artifact: { url: source.href, sha256: fields[1]!, bytes: Number(fields[2]) },
  } as NativeOperation;
}

function nativeArguments(text: string): Json[] {
  if (text.length > 32768) throw new Error("Arguments exceed the request budget.");
  const args: unknown = JSON.parse(text);
  if (!Array.isArray(args)) throw new Error("Enter arguments in a JSON array.");
  // JSON.parse accepts overflowing numbers. Exact quantities must never be
  // silently rounded by the browser before the canonical server validates them.
  const check = (value: unknown): void => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new Error("Use decimal strings for quantities beyond safe integers.");
    if (Array.isArray(value)) value.forEach(check);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(check);
  };
  args.forEach(check);
  return args;
}
export function memberOperation(member: NativeMember, text: string): NativeOperation {
  if (member.kind === "runtime_scale") {
    const input = text.trim().toLowerCase();
    if (input.length > 32768 || !/^0x(?:[0-9a-f]{2})*$/.test(input))
      throw new Error(
        "Enter bounded, even-length 0x-prefixed SCALE argument bytes for this runtime API version.",
      );
    return { kind: "runtime_scale", api: member.api!, member: member.member, input };
  }
  const args = nativeArguments(text);
  if (args.length !== member.args.length)
    throw new Error(`Enter exactly ${member.args.length} arguments in a JSON array.`);
  if (member.kind === "runtime")
    return { kind: "runtime", api: member.api!, member: member.member, args };
  if (member.kind === "constant")
    return { kind: "constant", pallet: member.pallet!, member: member.member };
  return { kind: member.kind, pallet: member.pallet!, member: member.member, args };
}

export function entryOperation(
  member: NativeMember,
  text: string,
  cursor?: string,
): NativeOperation {
  if (member.kind !== "storage" || member.args.length === 0)
    throw new Error("Choose a storage map to browse records.");
  const args = nativeArguments(text);
  if (args.length > member.args.length)
    throw new Error(`Enter up to ${member.args.length} leading keys.`);
  return {
    kind: "entries",
    pallet: member.pallet!,
    member: member.member,
    args,
    limit: 16,
    ...(cursor ? { cursor } : {}),
  };
}
export function nativePageCursor(artifact: NativeArtifact): string | null {
  const contract = artifact.results[0]?.contract;
  return contract !== null &&
    typeof contract === "object" &&
    !Array.isArray(contract) &&
    typeof contract.next_cursor === "string"
    ? contract.next_cursor
    : null;
}

export function nativeTypeLabel(artifact: NativeArtifact, id: number): string {
  const type = artifact.types.find((row) => row.id === id);
  if (!type) return `Type ${id}`;
  if (type.path.length) return type.path.join("::");
  const def = type.definition;
  const primitive = [
    "bool",
    "char",
    "str",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "u256",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "i256",
  ];
  return def.kind === "primitive" ? primitive[def.primitive] : `${def.kind} (type ${id})`;
}

export interface NativeValueRow {
  key: string;
  field: string;
  value: string;
}
function nativeIdentifier(value: Json): string | null {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2}){1,128}$/i.test(value)) return null;
  try {
    const bytes = Uint8Array.from(value.slice(2).match(/../g)!, (part) =>
      Number.parseInt(part, 16),
    );
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
export function nativeValueRows(artifact: NativeArtifact): NativeValueRow[] {
  const rows: NativeValueRow[] = [];
  const visit = (field: string, value: Json): void => {
    if (value !== null && typeof value === "object") {
      if (
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        Object.hasOwn(value, "name") &&
        Object.hasOwn(value, "value")
      ) {
        const name = nativeIdentifier(value.name!);
        if (name !== null) {
          visit(`${field}.${name}`, value.value!);
          return;
        }
      }
      const entries = Object.entries(value);
      if (entries.length) {
        for (const [key, child] of entries) visit(`${field}.${key}`, child);
        return;
      }
    }
    rows.push({
      key: field,
      field,
      value:
        value === null
          ? "Absent"
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value),
    });
  };
  artifact.results.forEach((result, index) => {
    const name = `${index + 1}. ${result.pallet ?? result.api ?? "Runtime"}.${result.member ?? "describe"}`;
    if (result.inner_result !== undefined) visit(`${name}.inner_result`, result.inner_result);
    if (result.evm_result !== undefined) visit(`${name}.evm_result`, result.evm_result);
    if (result.value !== undefined) visit(name, result.value);
    if (result.call_data !== undefined) visit(`${name}.call_data`, result.call_data);
  });
  return rows;
}

export function nativePageOffset(artifact: NativeArtifact): number | null {
  const contract = artifact.results[0]?.contract;
  return contract !== null &&
    typeof contract === "object" &&
    !Array.isArray(contract) &&
    typeof contract.next_offset === "number"
    ? contract.next_offset
    : null;
}

export function supportsNativeEvmCall(
  member: Pick<NativeMember, "kind" | "api" | "pallet" | "member">,
) {
  return (
    (member.kind === "runtime" &&
      member.api === "EthereumRuntimeRPCApi" &&
      member.member === "call") ||
    (member.kind === "prepare" && member.pallet === "EVM" && member.member === "call")
  );
}
export function evmCallOperation(
  operation: NativeOperation,
  signature: string,
  text: string,
): NativeOperation {
  if (!signature.trim()) return operation;
  if (
    (operation.kind !== "runtime" && operation.kind !== "prepare") ||
    !supportsNativeEvmCall(operation)
  )
    throw new Error("Choose an EVM call simulation or preparation operation.");
  return { ...operation, evm_call: { signature: signature.trim(), args: nativeArguments(text) } };
}

export function innerRecordOperation(operation: NativeOperation, enabled: boolean): NativeOperation {
  if (!enabled) return operation;
  if (operation.kind !== "runtime" && operation.kind !== "runtime_scale")
    throw new Error("Choose a legacy runtime record read.");
  return { ...operation, decode_inner: true };
}

export function supportsLegacyInnerRecord(spec: number, member: NativeMember) {
  return [205, 210, 211, 212, 216, 217, 218, 219].includes(spec) &&
    (member.kind === "runtime" || member.kind === "runtime_scale") &&
    ["DelegateInfoRuntimeApi", "NeuronInfoRuntimeApi", "SubnetInfoRuntimeApi", "StakeInfoRuntimeApi"].includes(member.api ?? "") &&
    ["get_delegates", "get_delegate", "get_delegated", "get_neurons", "get_neuron", "get_neurons_lite", "get_neuron_lite", "get_subnet_info", "get_subnets_info", "get_subnet_info_v2", "get_subnets_info_v2", "get_subnet_hyperparams", "get_stake_info_for_coldkey", "get_stake_info_for_coldkeys"].includes(member.member);
}
export function evmPrecompileOperation(
  member: NativeMember,
  text: string,
): Extract<NativeOperation, { kind: "describe" }> {
  if (!supportsNativeEvmCall(member)) throw new Error("Choose an EVM call operation.");
  const args = nativeArguments(text);
  const index = member.args.findIndex(
    (field) => field.name === (member.kind === "runtime" ? "to" : "target"),
  );
  const address = args[index];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error("Enter the precompile’s 20-byte to/target address in the native arguments.");
  return { kind: "describe", evm: address.toLowerCase(), offset: 0, limit: 64 };
}
export function nativeEvmFunctions(artifact: NativeArtifact | null): string[] {
  const rows = artifact?.results[0]?.value;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) =>
    row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    row.kind === "evm_function" &&
    typeof row.signature === "string"
      ? [row.signature]
      : [],
  );
}
