import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { getApiBase } from "./config";
import { metagraphedQueryKey } from "./queries";
import type { SubnetStakeQuote } from "./types";
import { accountHex, type NativeArtifact, type NativeOperation } from "./native-runtime";
import { asRao, asRawAlpha, taoToRao, UNITS_PER_WHOLE } from "./units";
import { buildAddStakeLimitParams, buildRemoveStakeLimitParams } from "./stake-extrinsics";

export interface NativeStakeQuote extends SubnetStakeQuote {
  source: NativeArtifact["source"];
  inputAtomic: bigint;
  outputAtomic: bigint;
  priceAtomic: bigint;
  taoFeeAtomic: bigint;
  alphaFeeAtomic: bigint;
  taoSlippageAtomic: bigint;
  alphaSlippageAtomic: bigint;
}

const U64_MAX = (1n << 64n) - 1n;
function atomic(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("The runtime returned an invalid atomic quantity.");
  const result = BigInt(value);
  if (result > U64_MAX) throw new Error("The runtime quantity exceeds u64.");
  return result;
}

export function nativeStakeInput(amount: string): bigint | null {
  try {
    const value = taoToRao(amount);
    return value > 0n && value <= U64_MAX ? value : null;
  } catch {
    return null;
  }
}

/** TAO target mode uses an exact ceil estimate, then the chain simulates that
 * alpha input. The displayed output always comes from that simulation. */
export function alphaForTaoTarget(target: bigint, price: bigint): bigint {
  if (target <= 0n || target > U64_MAX || price <= 0n || price > U64_MAX)
    throw new Error("Enter a valid amount and subnet price.");
  const alpha = (target * UNITS_PER_WHOLE + price - 1n) / price;
  if (alpha > U64_MAX) throw new Error("The estimated alpha input exceeds u64.");
  return alpha;
}

function runtime(member: string, args: (string | number)[]): NativeOperation {
  return { kind: "runtime", api: "SwapRuntimeApi", member, args };
}
function value(artifact: NativeArtifact, index: number, member: string) {
  const result = artifact.results[index];
  if (result?.kind !== "runtime" || result.api !== "SwapRuntimeApi" || result.member !== member)
    throw new Error("The response does not match the requested swap simulation.");
  return result.value;
}

export function decodeNativeStakeQuote(
  artifact: NativeArtifact,
  netuid: number,
  input: bigint,
  direction: "stake" | "unstake",
  price: bigint,
  index = 1,
): NativeStakeQuote {
  const member = direction === "stake" ? "sim_swap_tao_for_alpha" : "sim_swap_alpha_for_tao";
  const raw = value(artifact, index, member);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("The runtime returned an invalid swap result.");
  const tao = atomic(raw.tao_amount), alpha = atomic(raw.alpha_amount);
  const paid = direction === "stake" ? tao : alpha;
  const output = direction === "stake" ? alpha : tao;
  const taoFee = atomic(raw.tao_fee), alphaFee = atomic(raw.alpha_fee);
  // v470 reports the swap input after its input-token fee. Together they must
  // consume the requested input; an all-zero or partial result is not a fill.
  if (paid + (direction === "stake" ? taoFee : alphaFee) !== input || output === 0n || price <= 0n)
    throw new Error("The chain simulator could not fill this swap amount.");
  const taoSlippage = atomic(raw.tao_slippage), alphaSlippage = atomic(raw.alpha_slippage);
  const spot = Number(price) / Number(UNITS_PER_WHOLE);
  const effective = direction === "stake" ? Number(input) / Number(alpha) : Number(tao) / Number(input);
  return {
    schema_version: 1,
    netuid,
    direction,
    amount: Number(input) / Number(UNITS_PER_WHOLE),
    expected_out: Number(output) / Number(UNITS_PER_WHOLE),
    expected_out_unit: direction === "stake" ? "alpha" : "tao",
    spot_price_tao: spot,
    effective_price_tao: effective,
    price_impact_pct: Math.abs(effective / spot - 1) * 100,
    tao_in_pool_tao: null,
    alpha_in_pool: null,
    is_root: netuid === 0,
    source: artifact.source,
    inputAtomic: input,
    outputAtomic: output,
    priceAtomic: price,
    taoFeeAtomic: taoFee,
    alphaFeeAtomic: alphaFee,
    taoSlippageAtomic: taoSlippage,
    alphaSlippageAtomic: alphaSlippage,
  };
}

export async function fetchNativeStakeQuote(
  netuid: number,
  amount: bigint,
  direction: "stake" | "unstake",
  unit: "tao" | "alpha",
  signal?: AbortSignal,
): Promise<NativeStakeQuote> {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535 || amount <= 0n || amount > U64_MAX)
    throw new Error("Enter a valid subnet and atomic amount.");
  const read = async (operations: NativeOperation[], asOf?: string) =>
    (await apiFetch<NativeArtifact>("/api/v1/native-runtime", {
      signal,
      init: {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ operations, ...(asOf ? { as_of: asOf } : {}) }),
      },
    })).data;
  const priceOp = runtime("current_alpha_price", [netuid]);
  const member = direction === "stake" ? "sim_swap_tao_for_alpha" : "sim_swap_alpha_for_tao";
  if (direction === "unstake" && unit === "tao") {
    const first = await read([priceOp]);
    const price = atomic(value(first, 0, "current_alpha_price"));
    const input = alphaForTaoTarget(amount, price);
    const next = await read([runtime(member, [netuid, input.toString()])], first.source.finalized_block_hash);
    if (Object.entries(first.source).some(([key, expected]) => next.source[key as keyof NativeArtifact["source"]] !== expected))
      throw new Error("The swap simulation changed its finalized source.");
    return decodeNativeStakeQuote(next, netuid, input, direction, price, 0);
  }
  const artifact = await read([priceOp, runtime(member, [netuid, amount.toString()])]);
  return decodeNativeStakeQuote(artifact, netuid, amount, direction, atomic(value(artifact, 0, "current_alpha_price")));
}

export const nativeStakeQuoteQuery = (
  netuid: number,
  amount: bigint | null,
  direction: "stake" | "unstake",
  unit: "tao" | "alpha",
) => queryOptions({
  queryKey: metagraphedQueryKey("native-stake-quote", getApiBase(), netuid, amount?.toString(), direction, unit),
  queryFn: ({ signal }) => fetchNativeStakeQuote(netuid, amount!, direction, unit, signal),
  enabled: amount !== null,
  staleTime: 15_000,
  retry: 0,
});

/** The submitted amounts and price protection stay integer-exact. Round price
 * limits conservatively: add down, remove up. Display floats never feed this. */
export function nativeStakeParams(quote: NativeStakeQuote, hotkey: string, tolerancePct: number) {
  const text = String(tolerancePct);
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error("Use a tolerance below 100% with at most two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const basis = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(basis) || basis >= 10_000)
    throw new Error("Use a tolerance below 100% with at most two decimal places.");
  const factor = BigInt(quote.direction === "stake" ? 10_000 + basis : 10_000 - basis);
  const numerator = quote.priceAtomic * factor;
  const limit = (numerator + (quote.direction === "unstake" ? 9_999n : 0n)) / 10_000n;
  if (limit <= 0n || limit > U64_MAX) throw new Error("The price limit exceeds the native range.");
  return quote.direction === "stake"
    ? buildAddStakeLimitParams({ hotkey, netuid: quote.netuid, amountStaked: asRao(quote.inputAtomic), limitPrice: asRao(limit), allowPartial: false })
    : buildRemoveStakeLimitParams({ hotkey, netuid: quote.netuid, amountUnstaked: asRawAlpha(quote.inputAtomic), limitPrice: asRao(limit), allowPartial: false });
}

export function nativeStakeOperation(params: ReturnType<typeof nativeStakeParams>): NativeOperation {
  return {
    kind: "prepare",
    pallet: "SubtensorModule",
    member: params.call,
    args: [accountHex(params.hotkey), params.netuid,
      (params.call === "add_stake_limit" ? params.amountStaked : params.amountUnstaked).toString(),
      params.limitPrice.toString(), params.allowPartial],
  };
}

export async function prepareNativeStakeCall(quote: NativeStakeQuote, params: ReturnType<typeof nativeStakeParams>) {
  const response = await apiFetch<NativeArtifact>("/api/v1/native-runtime", {
    init: {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ as_of: quote.source.finalized_block_hash, operations: [nativeStakeOperation(params)] }),
    },
  });
  if (Object.entries(quote.source).some(([key, expected]) => response.data.source[key as keyof NativeArtifact["source"]] !== expected))
    throw new Error("The staking call changed its finalized quote source.");
  return response.data;
}
