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
] as const;
export type NativeFeature = (typeof NATIVE_FEATURES)[number]["id"];

function accountHex(value: string): string {
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
  }
}

export interface NativeMember {
  kind: "storage" | "constant" | "runtime" | "prepare";
  pallet?: string;
  api?: string;
  member: string;
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
    if (!["storage", "constant", "runtime", "prepare"].includes(String(row.kind))) return [];
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
        args,
      },
    ];
  });
}

function nativeArguments(text: string):Json[] {
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
  const args=nativeArguments(text);
  if(args.length!==member.args.length)throw new Error(`Enter exactly ${member.args.length} arguments in a JSON array.`);
  if (member.kind === "runtime")
    return { kind: "runtime", api: member.api!, member: member.member, args };
  if (member.kind === "constant")
    return { kind: "constant", pallet: member.pallet!, member: member.member };
  return { kind: member.kind, pallet: member.pallet!, member: member.member, args };
}

export function entryOperation(member:NativeMember,text:string,cursor?:string):NativeOperation{
  if(member.kind!=="storage"||member.args.length===0)throw new Error("Choose a storage map to browse records.");
  const args=nativeArguments(text);
  if(args.length>member.args.length)throw new Error(`Enter up to ${member.args.length} leading keys.`);
  return {kind:"entries",pallet:member.pallet!,member:member.member,args,limit:16,...(cursor?{cursor}:{})};
}
export function nativePageCursor(artifact:NativeArtifact):string|null{
  const contract=artifact.results[0]?.contract;
  return contract!==null&&typeof contract==="object"&&!Array.isArray(contract)&&typeof contract.next_cursor==="string"?contract.next_cursor:null;
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
function nativeIdentifier(value:Json):string|null{
  if(typeof value!=="string"||!/^0x(?:[0-9a-f]{2}){1,128}$/i.test(value))return null;
  try{
    const bytes=Uint8Array.from(value.slice(2).match(/../g)!,part=>Number.parseInt(part,16));
    const name=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)?name:null;
  }catch{return null;}
}
export function nativeValueRows(artifact: NativeArtifact): NativeValueRow[] {
  const rows: NativeValueRow[] = [];
  const visit = (field: string, value: Json): void => {
    if (value !== null && typeof value === "object") {
      if(!Array.isArray(value)&&Object.keys(value).length===2&&Object.hasOwn(value,"name")&&Object.hasOwn(value,"value")){
        const name=nativeIdentifier(value.name!);
        if(name!==null){visit(`${field}.${name}`,value.value!);return;}
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
