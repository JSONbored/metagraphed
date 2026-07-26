import { decodeChainEventArgs } from "./chain-event-args";

// #8253: the /chain events feed rendered every row as just
// `Pallet.Method · #8,705,088 · 1m ago` — no amounts, no addresses, no
// subnet — even though the API has returned fully-decoded `args` all along.
// This turns those args into the structured fields a row needs to answer
// who / what / how-much / where without clicking through.

const RAO_PER_TAO = 1e9;

/** Account-ish arg keys, in the order a row should prefer them for "from". */
const FROM_KEYS = ["from", "source", "who", "account", "coldkey", "hotkey", "sender"];
/** Account-ish arg keys, in the order a row should prefer them for "to". */
const TO_KEYS = ["to", "dest", "destination", "target", "delegate", "validator", "recipient"];
/** Amount-ish arg keys, in preference order. */
const AMOUNT_KEYS = [
  "amount",
  "amount_tao",
  "value",
  "stake",
  "actual_fee",
  "fee",
  "tip",
  "balance",
];

/**
 * The high-volume plumbing events that dominate an unfiltered feed. These are
 * the same rows block detail already collapses by default: they fire on
 * essentially every extrinsic and carry no information a reader is looking
 * for when scanning "what happened on chain".
 *
 * Measured live 2026-07-26 against the newest 100 events: 68% of the feed was
 * these three. Hiding them by default is what makes the feed readable.
 */
export const NOISE_EVENTS = new Set([
  "System.ExtrinsicSuccess",
  "System.ExtrinsicFailed",
  "TransactionPayment.TransactionFeePaid",
]);

export function isNoiseEvent(pallet: string | null, method: string | null): boolean {
  if (!pallet || !method) return false;
  return NOISE_EVENTS.has(`${pallet}.${method}`);
}

/**
 * SCALE-decoded args arrive with scalars wrapped in single-element arrays
 * (verified live: `netuid: [102]`, `actual_fee: [0]`, `tip: [0]`), so a naive
 * read of these fields yields an array where a number is expected.
 */
function unwrap(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First present key from `keys`, unwrapped. Case-insensitive on arg names. */
function pick(args: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map(Object.entries(args).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    if (lower.has(key)) {
      const value = unwrap(lower.get(key));
      if (value != null) return value;
    }
  }
  return undefined;
}

/** An ss58 address is a base58 string; a 0x-hex hash is not an address. */
function asAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 40 && !value.startsWith("0x") ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Large rao amounts can arrive as numeric strings to survive JSON precision.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export interface ChainEventSummary {
  /** τ amount, already converted from rao. Null when the event carries none. */
  amountTao: number | null;
  from: string | null;
  to: string | null;
  netuid: number | null;
}

/**
 * Extract the display fields for one chain-event row from its decoded args.
 *
 * Amounts are assumed to be rao (the chain's own base unit, 1e9 per TAO) --
 * every balance-shaped field in these events is rao on the wire. A field that
 * isn't a finite number is reported as null rather than guessed at.
 */
export function summarizeChainEvent(args: unknown): ChainEventSummary {
  const decoded = asRecord(decodeChainEventArgs(args));
  if (!decoded) return { amountTao: null, from: null, to: null, netuid: null };

  const rawAmount = asNumber(pick(decoded, AMOUNT_KEYS));
  const netuid = asNumber(pick(decoded, ["netuid", "net_uid", "subnet"]));
  const from = asAddress(pick(decoded, FROM_KEYS));
  const to = asAddress(pick(decoded, TO_KEYS));

  return {
    amountTao: rawAmount == null ? null : rawAmount / RAO_PER_TAO,
    from,
    // A single-account event (e.g. Commitments.Commitment's `who`) must not
    // render the same address as both sides of a transfer.
    to: to && to !== from ? to : null,
    netuid: netuid == null ? null : Math.trunc(netuid),
  };
}
