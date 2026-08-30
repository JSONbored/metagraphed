// Truthful per-block economics, derived once from a completed chain-detail
// batch. These totals deliberately keep unlike quantities apart: native TAO
// transfers, TAO entering/leaving staking, issuance, fees, tips and alpha are
// not interchangeable merely because an event row carries a number.

import {
  taoUsdUsable,
  type AlphaUsdUnavailable,
  type TaoUsdReading,
} from "./alpha-usd.ts";

type Row = Record<string, unknown>;

const DECIMAL_SCALE = 18;
const SCALE = 10n ** BigInt(DECIMAL_SCALE);
const DECIMAL = /^\d+(?:\.(\d+))?$/;

const NATIVE_TRANSFER_KINDS = new Set(["Transfer"]);
const STAKE_FLOW_KINDS = new Set(["StakeAdded", "StakeRemoved"]);
const ISSUANCE_KINDS = new Set(["Issued"]);
const NETUID_NAMES = new Set([
  "netuid",
  "subnet_id",
  "src_netuid",
  "dest_netuid",
  "origin_netuid",
  "destination_netuid",
]);

export interface BlockEconomicsSummary {
  native_transfer_tao: string | null;
  stake_flow_tao: string | null;
  economic_activity_tao: string | null;
  fee_tao: string | null;
  tip_tao: string | null;
  issuance_tao: string | null;
  subnet_ids: number[];
  economics_complete: 1;
}

export interface BlockEconomicsUsd {
  economic_activity_usd: number | null;
  usd_per_tao: number | null;
  tao_usd_block: number | null;
  tao_usd_observed_at: string | null;
  tao_usd_basis: string | null;
  tao_usd_unavailable?: AlphaUsdUnavailable;
}

function scaledDecimal(value: unknown): bigint | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (
    fraction.length > DECIMAL_SCALE &&
    /[1-9]/.test(fraction.slice(DECIMAL_SCALE))
  ) {
    return null;
  }
  const padded = fraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0");
  return BigInt(whole) * SCALE + BigInt(padded);
}

function decimalString(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE)
    .toString()
    .padStart(DECIMAL_SCALE, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function add(
  value: unknown,
  state: { total: bigint; complete: boolean },
): void {
  const parsed = scaledDecimal(value);
  if (parsed === null) state.complete = false;
  else state.total += parsed;
}

function result(state: { total: bigint; complete: boolean }): string | null {
  return state.complete ? decimalString(state.total) : null;
}

function index(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function collectNamedNetuids(
  value: unknown,
  into: Set<number>,
  depth = 0,
): void {
  if (value == null || depth > 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectNamedNetuids(entry, into, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const row = value as Row;
  if (
    typeof row.name === "string" &&
    NETUID_NAMES.has(row.name.toLowerCase())
  ) {
    const found = index(row.value);
    if (found !== null) into.add(found);
  }
  for (const [name, entry] of Object.entries(row)) {
    if (NETUID_NAMES.has(name.toLowerCase())) {
      const found = index(entry);
      if (found !== null) into.add(found);
    }
    if (name !== "name") collectNamedNetuids(entry, into, depth + 1);
  }
}

/** Price one already-derived block total with the one reading shared by the response. */
export function blockEconomicsUsd(
  economicActivityTao: unknown,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): BlockEconomicsUsd {
  const tao =
    typeof economicActivityTao === "string" && DECIMAL.test(economicActivityTao)
      ? Number(economicActivityTao)
      : typeof economicActivityTao === "number" &&
          Number.isFinite(economicActivityTao)
        ? economicActivityTao
        : null;
  // A price reading is not applicable until the block has a measured native
  // total. Omitting it here also keeps settled, undecodable block records
  // independent from a live index that changes after the block was produced.
  if (tao === null) {
    return {
      economic_activity_usd: null,
      usd_per_tao: null,
      tao_usd_block: null,
      tao_usd_observed_at: null,
      tao_usd_basis: null,
    };
  }

  const usable = taoUsdUsable(reading, nowMs);
  if (!usable.ok) {
    return {
      economic_activity_usd: null,
      usd_per_tao: null,
      tao_usd_block: null,
      tao_usd_observed_at: null,
      tao_usd_basis: null,
      tao_usd_unavailable: usable.reason,
    };
  }

  const rate = reading!.usd_per_tao as number;
  const usd = tao * rate;
  return {
    economic_activity_usd:
      usd !== null && Number.isFinite(usd) ? Number(usd.toFixed(6)) : null,
    usd_per_tao: rate,
    tao_usd_block: reading!.block_number ?? null,
    // taoUsdUsable rejects an absent or malformed observation stamp.
    tao_usd_observed_at: reading!.observed_at,
    tao_usd_basis: reading!.price_basis ?? null,
  };
}

function callArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Summarise one fully decoded block.
 *
 * A complete batch with no matching events returns real zeroes. A matching
 * event/extrinsic whose required amount is missing returns null for that
 * category instead; an unusable amount must never be silently counted as zero.
 */
export function summarizeBlockEconomics(
  extrinsics: readonly Row[],
  accountEvents: readonly Row[],
): BlockEconomicsSummary {
  const native = { total: 0n, complete: true };
  const stake = { total: 0n, complete: true };
  const issuance = { total: 0n, complete: true };
  const fees = { total: 0n, complete: true };
  const tips = { total: 0n, complete: true };
  const subnetIds = new Set<number>();

  for (const event of accountEvents) {
    const kind = typeof event.event_kind === "string" ? event.event_kind : "";
    if (NATIVE_TRANSFER_KINDS.has(kind)) add(event.amount_tao, native);
    else if (STAKE_FLOW_KINDS.has(kind)) add(event.amount_tao, stake);
    else if (ISSUANCE_KINDS.has(kind)) add(event.amount_tao, issuance);

    const netuid = index(event.netuid);
    if (netuid !== null) subnetIds.add(netuid);
  }

  for (const extrinsic of extrinsics) {
    // Inherents and unsigned calls do not pay transaction fees. A signed call
    // with no decoded fee/tip is an unknown reading, not a free transaction.
    if (extrinsic.signer != null) {
      add(extrinsic.fee_tao, fees);
      add(extrinsic.tip_tao, tips);
    }
    collectNamedNetuids(callArgs(extrinsic.call_args), subnetIds);
  }

  const nativeValue = result(native);
  const stakeValue = result(stake);
  const activity =
    nativeValue === null || stakeValue === null
      ? null
      : decimalString(native.total + stake.total);

  return {
    native_transfer_tao: nativeValue,
    stake_flow_tao: stakeValue,
    economic_activity_tao: activity,
    fee_tao: result(fees),
    tip_tao: result(tips),
    issuance_tao: result(issuance),
    subnet_ids: [...subnetIds].sort((left, right) => left - right),
    economics_complete: 1,
  };
}
