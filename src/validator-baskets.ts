// The Root-basket serving builders (#13163) -- shared by the REST handlers
// (/chain/baskets, /validators/{hotkey}/basket), the GraphQL resolver and the
// MCP tool, so the surfaces cannot drift. Pure + exported for tests; the
// loaders resolve the capture store (the ROOT_BASKET_STORE seam the capture
// receiver already owns) and hand the rows in.
//
// THE DECLINE IS A NULL CAPTURE. A completed capture is a verified complete
// enumeration of every fund (migration 0021's completion triggers), so with a
// capture present an empty basket list or an absent fund IS a measurement.
// With no store bound -- today's deployed Workers -- or no completed capture
// accepted yet, `capture: null` with `fund_count: null` is the only honest
// answer, never a fabricated zero-fund chain.
//
// Quantities stay the canonical decimal text the capture lane stores (u64
// rao / alpha atomic; Q64.64 bits as u128), never rounded through a float.
import { selectedRootBasketStore } from "./root-basket-store.ts";
import { decodeSs58, encodeAccountId32 } from "./ss58.ts";

/** The receiver's fund ceiling (ROOT_BASKET_CAPTURE_LIMITS.funds), restated
 * here as a literal because the capture-write module that owns it is
 * deliberately kept out of the request-worker graphs (it imports
 * node:crypto for the acceptance digest). tests/validator-baskets.test.ts
 * pins the two numbers together. */
export const VALIDATOR_BASKETS_FUND_CAP = 2_048;

type Row = Record<string, unknown>;

const U64_MAX = 18446744073709551615n;
const U128_MAX = 340282366920938463463374607431768211455n;

function decimalTextOrNull(value: unknown, max: bigint): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  return BigInt(value) <= max ? value : null;
}

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const ACCOUNT_HEX = /^0x[0-9a-f]{64}$/;

/** A stored 0x account id back to its finney SS58 spelling, or null. */
function hexToSs58(hex: string): string | null {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return encodeAccountId32(bytes);
}

/** A caller's SS58 hotkey to the 0x account-id hex the capture tables key on. */
export function basketAccountHex(ss58: string): string | null {
  const decoded = decodeSs58(ss58);
  if (!decoded) return null;
  let hex = "0x";
  for (const byte of decoded.publicKey) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function formatBasketCapture(row: Row | null): Row | null {
  const finalizedBlock = decimalTextOrNull(row?.finalized_block, U64_MAX);
  const blockHash =
    typeof row?.finalized_block_hash === "string" &&
    ACCOUNT_HEX.test(row.finalized_block_hash)
      ? row.finalized_block_hash
      : null;
  const spec = nonNegativeInt(row?.runtime_spec_version);
  const decoder =
    typeof row?.decoder_version === "string" && row.decoder_version !== ""
      ? row.decoder_version
      : null;
  // A capture row missing its identity names no source to attribute values
  // to; decline rather than serve quantities nothing pins to a block.
  if (
    finalizedBlock === null ||
    blockHash === null ||
    spec === null ||
    decoder === null
  )
    return null;
  return {
    finalized_block: finalizedBlock,
    finalized_block_hash: blockHash,
    runtime_spec_version: spec,
    decoder_version: decoder,
    accepted_at: toIso(row?.accepted_at_ms),
  };
}

export function formatBasketFund(row: Row): Row | null {
  const accountId =
    typeof row?.hotkey === "string" && ACCOUNT_HEX.test(row.hotkey)
      ? row.hotkey
      : null;
  // A fund without a usable account id names nothing; drop it rather than
  // serve a basket that cannot be attributed.
  if (accountId === null) return null;
  const provisional =
    row?.provisional == null
      ? null
      : Number(row.provisional) === 1
        ? true
        : Number(row.provisional) === 0
          ? false
          : null;
  const firstBlock = decimalTextOrNull(row?.first_block, U64_MAX);
  return {
    hotkey: hexToSs58(accountId),
    account_id: accountId,
    shares_atomic: decimalTextOrNull(row?.shares_atomic, U64_MAX),
    spot_nav_rao: decimalTextOrNull(row?.spot_nav_rao, U64_MAX),
    realizable_nav_rao: decimalTextOrNull(row?.realizable_nav_rao, U64_MAX),
    deposited_rao: decimalTextOrNull(row?.deposited_rao, U64_MAX),
    redeemed_rao: decimalTextOrNull(row?.redeemed_rao, U64_MAX),
    display_price_q64_bits: decimalTextOrNull(
      row?.display_price_q64_bits,
      U128_MAX,
    ),
    stake_price_q64_bits: decimalTextOrNull(
      row?.stake_price_q64_bits,
      U128_MAX,
    ),
    staker_twr_q64_bits: decimalTextOrNull(row?.staker_twr_q64_bits, U128_MAX),
    pending_entitlement_q64_bits: decimalTextOrNull(
      row?.pending_entitlement_q64_bits,
      U128_MAX,
    ),
    provisional,
    // A provisional baseline stores first_block='0', which is a placeholder
    // rather than a stamped block; serve it as null.
    first_block: firstBlock === "0" ? null : firstBlock,
    holdings_count: nonNegativeInt(row?.holdings_count),
    targets_count: nonNegativeInt(row?.targets_count),
  };
}

function formatHolding(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  if (netuid === null || netuid > 65535) return null;
  return {
    netuid,
    quantity_atomic: decimalTextOrNull(row?.quantity_atomic, U64_MAX),
    quantity_unit:
      row?.quantity_unit === "rao" || row?.quantity_unit === "alpha_atomic"
        ? row.quantity_unit
        : null,
    spot_value_rao: decimalTextOrNull(row?.spot_value_rao, U64_MAX),
    realizable_value_rao: decimalTextOrNull(row?.realizable_value_rao, U64_MAX),
  };
}

function formatTarget(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  const weight = nonNegativeInt(row?.weight);
  if (netuid === null || netuid > 65535 || weight === null || weight > 65535)
    return null;
  return { netuid, weight };
}

export function buildValidatorBaskets(
  loaded: { capture: Row | null; funds?: Row[] } | null,
): Row {
  const capture = formatBasketCapture(loaded?.capture ?? null);
  if (capture === null) {
    return { schema_version: 1, capture: null, fund_count: null, baskets: [] };
  }
  const baskets = (loaded?.funds ?? [])
    .map((row) => formatBasketFund(row))
    .filter((row): row is Row => row !== null);
  return { schema_version: 1, capture, fund_count: baskets.length, baskets };
}

export function buildValidatorBasket(
  loaded: {
    capture: Row | null;
    fund?: Row | null;
    holdings?: Row[];
    targets?: Row[];
  } | null,
  hotkey: string,
): Row {
  const capture = formatBasketCapture(loaded?.capture ?? null);
  if (capture === null) {
    return {
      schema_version: 1,
      hotkey,
      capture: null,
      basket: null,
      holdings: [],
      targets: [],
    };
  }
  const basket = loaded?.fund ? formatBasketFund(loaded.fund) : null;
  return {
    schema_version: 1,
    hotkey,
    capture,
    basket,
    holdings:
      basket === null
        ? []
        : (loaded?.holdings ?? [])
            .map((row) => formatHolding(row))
            .filter((row): row is Row => row !== null),
    targets:
      basket === null
        ? []
        : (loaded?.targets ?? [])
            .map((row) => formatTarget(row))
            .filter((row): row is Row => row !== null),
  };
}

/** The capture-identity row the newest-capture SELECT produces, named so the
 * read is drift-covered. Bigint columns cross as text (::text casts). */
type BasketCaptureRow = {
  capture_id: string;
  finalized_block: string;
  finalized_block_hash: string;
  runtime_spec_version: number;
  decoder_version: string;
  accepted_at_ms: string | null;
};

/** One fund row of the funds SELECT, named so the read is drift-covered. */
type BasketFundRow = {
  hotkey: string;
  shares_atomic: string | null;
  spot_nav_rao: string | null;
  realizable_nav_rao: string | null;
  deposited_rao: string | null;
  redeemed_rao: string | null;
  display_price_q64_bits: string | null;
  stake_price_q64_bits: string | null;
  staker_twr_q64_bits: string | null;
  pending_entitlement_q64_bits: string | null;
  provisional: number;
  first_block: string | null;
  holdings_count: number;
  targets_count: number;
};

type BasketHoldingRow = {
  netuid: number;
  quantity_atomic: string | null;
  quantity_unit: string | null;
  spot_value_rao: string | null;
  realizable_value_rao: string | null;
};

type BasketTargetRow = { netuid: number; weight: number };

// The newest COMPLETED finney capture: completion receipts exist only for
// captures whose every child row was verified (migration 0021), so joining
// through them is what makes "newest" safe to serve. Heights compare as
// (digit count, text) -- the canonical decimal-text ordering every basket
// statement uses.
const CURRENT_CAPTURE_SQL =
  "SELECT c.capture_id, c.finalized_block, c.finalized_block_hash, " +
  "c.runtime_spec_version::int AS runtime_spec_version, c.decoder_version, " +
  "r.accepted_at_ms " +
  "FROM root_basket_captures c " +
  "JOIN root_basket_capture_completions r ON r.capture_id = c.capture_id " +
  "WHERE c.network = 'finney' " +
  "ORDER BY length(c.finalized_block) DESC, c.finalized_block DESC LIMIT 1";

const FUND_COLUMNS =
  "hotkey, shares_atomic, spot_nav_rao, realizable_nav_rao, deposited_rao, " +
  "redeemed_rao, display_price_q64_bits, stake_price_q64_bits, " +
  "staker_twr_q64_bits, pending_entitlement_q64_bits, " +
  "provisional::int AS provisional, first_block, " +
  "holdings_count::int AS holdings_count, targets_count::int AS targets_count";

/**
 * The newest completed capture with every fund, through the seam -- or null.
 *
 * Null for "no store bound" (today's deployed Workers), "no completed capture
 * yet" AND a failed read: all render as the same schema-stable decline,
 * because a caller cannot act differently on the three and an error body
 * would turn a degraded tier into a hard failure the sibling chain routes
 * never have.
 */
export async function loadValidatorBaskets(
  env: unknown,
): Promise<{ capture: Row; funds: Row[] } | null> {
  const store = selectedRootBasketStore(env);
  if (!store) return null;
  try {
    const capture =
      await store.read.first<BasketCaptureRow>(CURRENT_CAPTURE_SQL);
    if (!capture) return null;
    const funds = await store.read.query<BasketFundRow>(
      `SELECT ${FUND_COLUMNS} FROM root_basket_fund_snapshots ` +
        "WHERE capture_id = ? " +
        "ORDER BY length(spot_nav_rao) DESC, spot_nav_rao DESC, hotkey " +
        `LIMIT ${VALIDATOR_BASKETS_FUND_CAP}`,
      [capture.capture_id],
    );
    return { capture, funds };
  } catch (error) {
    console.error("root basket store read failed:", error);
    return null;
  }
}

/** One hotkey's basket at the newest completed capture -- same decline rules
 * as loadValidatorBaskets; `fund: null` with a capture is a measurement. */
export async function loadValidatorBasket(
  env: unknown,
  accountHex: string,
): Promise<{
  capture: Row;
  fund: Row | null;
  holdings: Row[];
  targets: Row[];
} | null> {
  const store = selectedRootBasketStore(env);
  if (!store) return null;
  try {
    const capture =
      await store.read.first<BasketCaptureRow>(CURRENT_CAPTURE_SQL);
    if (!capture) return null;
    const fund = await store.read.first<BasketFundRow>(
      `SELECT ${FUND_COLUMNS} FROM root_basket_fund_snapshots ` +
        "WHERE capture_id = ? AND hotkey = ?",
      [capture.capture_id, accountHex],
    );
    if (!fund) return { capture, fund: null, holdings: [], targets: [] };
    // SEQUENTIAL, deliberately: each read through this seam is its own
    // admission-controlled transaction, so firing both at once can hit the
    // runtime's connection ceiling and turn a healthy store into a decline.
    const holdings = await store.read.query<BasketHoldingRow>(
      "SELECT netuid::int AS netuid, quantity_atomic, quantity_unit, " +
        "spot_value_rao, realizable_value_rao FROM root_basket_holdings " +
        "WHERE capture_id = ? AND hotkey = ? ORDER BY netuid",
      [capture.capture_id, accountHex],
    );
    const targets = await store.read.query<BasketTargetRow>(
      "SELECT netuid::int AS netuid, weight::int AS weight " +
        "FROM root_basket_targets " +
        "WHERE capture_id = ? AND hotkey = ? ORDER BY netuid",
      [capture.capture_id, accountHex],
    );
    return { capture, fund, holdings, targets };
  } catch (error) {
    console.error("root basket store read failed:", error);
    return null;
  }
}
