import { z } from "zod";
import type { NativeValue } from "./native-runtime-values.ts";

// Request admission limits, not runtime/chain capacity or latency promises.
// Weight ref_time is measured in reference picoseconds. Exact metadata encoding
// happens before this check; a missing gas limit must never select max_block.
export const NATIVE_CONTRACT_SIMULATION_LIMITS = {
  refTime: 250_000_000_000n,
  proofSize: 65_536n,
  codeBytes: 16_384,
  codeUploads: 1,
} as const;

const exact = z
  .union([
    z.string().regex(/^(0|[1-9]\d*)$/).max(20),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value));
const weight = z.union([
  z.object({ ref_time: exact, proof_size: exact }).strict(),
  // Historical WeightV1 is a single reference-time integer.
  exact.transform((ref_time) => ({ ref_time, proof_size: 0n })),
]);
const explicitWeight = z
  .object({ variant: z.literal("Some"), fields: weight })
  .strict();
const bytes = z.union([
  z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((value) => (value.length - 2) / 2),
  z.array(z.number().int().min(0).max(255)).transform((value) => value.length),
]);
const code = z.discriminatedUnion("variant", [
  z.object({ variant: z.literal("Upload"), fields: bytes }).strict(),
  z.object({ variant: z.literal("Existing"), fields: z.string() }).strict(),
]);

export function nativeContractSimulationWork(
  member: string,
  inputs: readonly { name: string | null }[],
  args: readonly NativeValue[],
) {
  const work = { refTime: 0n, proofSize: 0n, codeBytes: 0, codeUploads: 0 };
  const argument = (name: string) => {
    const indexes = inputs.flatMap((field, index) => field.name === name ? [index] : []);
    if (indexes.length !== 1) throw new Error(`Contract simulation requires a declared ${name}`);
    return args[indexes[0]!]!;
  };
  if (member === "call" || member === "instantiate") {
    const parsed = explicitWeight.safeParse(argument("gas_limit"));
    if (!parsed.success) throw new Error("Contract simulation requires an explicit exact gas_limit Weight");
    work.refTime = parsed.data.fields.ref_time;
    work.proofSize = parsed.data.fields.proof_size;
    if (work.refTime === 0n || work.refTime > NATIVE_CONTRACT_SIMULATION_LIMITS.refTime || work.proofSize > NATIVE_CONTRACT_SIMULATION_LIMITS.proofSize)
      throw new Error("Contract simulation exceeds its Weight budget");
  }
  if (member === "instantiate") {
    const parsed = code.parse(argument("code"));
    if (parsed.variant === "Upload") {
      work.codeBytes = parsed.fields;
      work.codeUploads = 1;
    }
  } else if (member === "upload_code") {
    work.codeBytes = bytes.parse(argument("code"));
    work.codeUploads = 1;
  }
  if (work.codeBytes > NATIVE_CONTRACT_SIMULATION_LIMITS.codeBytes)
    throw new Error("Contract simulation exceeds its code byte budget");
  return work;
}

export function assertNativeContractSimulationBudget(
  rows: Iterable<ReturnType<typeof nativeContractSimulationWork>>,
) {
  const total = { refTime: 0n, proofSize: 0n, codeBytes: 0, codeUploads: 0 };
  for (const row of rows) {
    total.refTime += row.refTime;
    total.proofSize += row.proofSize;
    total.codeBytes += row.codeBytes;
    total.codeUploads += row.codeUploads;
  }
  if (total.refTime > NATIVE_CONTRACT_SIMULATION_LIMITS.refTime || total.proofSize > NATIVE_CONTRACT_SIMULATION_LIMITS.proofSize || total.codeBytes > NATIVE_CONTRACT_SIMULATION_LIMITS.codeBytes || total.codeUploads > NATIVE_CONTRACT_SIMULATION_LIMITS.codeUploads)
    throw new Error("Contract simulations exceed the aggregate Weight or code budget");
}
