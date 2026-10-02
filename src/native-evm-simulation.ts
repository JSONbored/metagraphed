import { z } from "zod";
import type { NativeField } from "./native-runtime-metadata.ts";
import type { NativeValue } from "./native-runtime-values.ts";

const exactGasInteger = z.union([
  z.string().regex(/^(0|[1-9]\d*)$/).max(79).transform((value) => BigInt(value)),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform((value) => BigInt(value)),
]);
// primitive_types::U256 declares four little-endian u64 limbs. Admission
// interprets all limbs; the value encoder still checks the source type.
const evmGasInteger = z.union([
  exactGasInteger,
  z.array(exactGasInteger.refine((value) => value < 1n << 64n)).length(4)
    .transform((limbs) => limbs.reduceRight((value, limb) => (value << 64n) | limb, 0n)),
]);

export const NATIVE_EVM_SIMULATION_GAS_BUDGET = 1_000_000n;

/** Shared admission runs before artifact fetching and before execution. */
export function nativeEvmSimulationGas(fields: NativeField[], args: NativeValue[]) {
  const gasFields = fields.flatMap((field, index) => field.name === "gas_limit" ? [index] : []);
  if (gasFields.length !== 1)
    throw new Error("EVM simulation requires a declared gas_limit");
  const gas = evmGasInteger.safeParse(args[gasFields[0]!]!);
  if (!gas.success)
    throw new Error("EVM simulation gas must be an exact nonnegative integer");
  if (gas.data === 0n || gas.data > NATIVE_EVM_SIMULATION_GAS_BUDGET)
    throw new Error("EVM simulation exceeds its gas budget");
  return gas.data;
}
