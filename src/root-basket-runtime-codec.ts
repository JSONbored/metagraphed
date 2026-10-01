// SCALE layouts audited against v469 rpc_info/basket_info.rs. Exact atomic
// values and fixed-point bits stay decimal strings, including u64 > 2^53.
import {
  ROOT_BASKET_READ_LIMITS,
  RootBasketClaimPreviewSchema,
  RootBasketIndexSchema,
  RootBasketPositionSchema,
  RootBasketPricingPageSchema,
  RootBasketPricingSchema,
  RootBasketSummarySchema,
  RootBasketTradingStatusSchema,
} from "../schemas-src/root-basket-runtime.ts";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";

class ScaleReader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(hex: unknown) {
    if (
      typeof hex !== "string" ||
      hex.length > 2 + 2 * ROOT_BASKET_READ_LIMITS.bytes ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)
    )
      throw new Error("Invalid or oversized basket SCALE response");
    this.bytes = Uint8Array.from(hex.slice(2).match(/../g) ?? [], (part) =>
      Number.parseInt(part, 16),
    );
  }
  take(size: number): Uint8Array {
    if (size > this.bytes.length - this.offset)
      throw new Error("Truncated basket SCALE response");
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  integer(size: number): bigint {
    const bytes = this.take(size);
    let value = 0n;
    for (let i = size - 1; i >= 0; i--)
      value = (value << 8n) | BigInt(bytes[i]!);
    return value;
  }
  u64(): string {
    return this.integer(8).toString();
  }
  q64(): string {
    return this.integer(16).toString();
  }
  u32(): number {
    return Number(this.integer(4));
  }
  bool(): boolean {
    const value = this.take(1)[0]!;
    if (value > 1) throw new Error("Invalid basket SCALE discriminant");
    return value === 1;
  }
  account(): string {
    return `0x${Array.from(this.take(32), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  vector<T>(maximum: number, read: () => T): T[] {
    const first = this.take(1)[0]!;
    const mode = first & 3;
    let length: number;
    if (mode === 0) length = first >>> 2;
    else if (mode === 1) {
      length = (first | (this.take(1)[0]! << 8)) >>> 2;
      if (length < 64) throw new Error("Noncanonical basket SCALE length");
    } else if (mode === 2) {
      const rest = this.take(3);
      length =
        (first + rest[0]! * 256 + rest[1]! * 65_536 + rest[2]! * 16_777_216) /
        4;
      length = Math.floor(length);
      if (length < 16_384) throw new Error("Noncanonical basket SCALE length");
    } else throw new Error("Basket SCALE vector exceeds work budget");
    if (length > maximum)
      throw new Error("Basket SCALE vector exceeds work budget");
    return Array.from({ length }, read);
  }
  option<T>(read: () => T): T | null {
    return this.bool() ? read() : null;
  }
  finish<T>(value: T): T {
    if (this.offset !== this.bytes.length)
      throw new Error("Trailing basket SCALE bytes");
    return value;
  }
}

function pricing(reader: ScaleReader) {
  return {
    hotkey: reader.account(),
    raw_spot_price_q64_bits: reader.q64(),
    display_price_q64_bits: reader.q64(),
    stake_price_q64_bits: reader.q64(),
    pending_entitlement_q64_bits: reader.q64(),
    staker_twr_q64_bits: reader.q64(),
    bag_index_q64_bits: reader.q64(),
    stake_index_q64_bits: reader.q64(),
    first_block: reader.u64(),
    provisional: reader.bool(),
    spot_nav_rao: reader.u64(),
    shares_atomic: reader.u64(),
    display_shares_q64_bits: reader.q64(),
  };
}

function position(reader: ScaleReader) {
  return {
    hotkey: reader.account(),
    beta_atomic: reader.u64(),
    display_beta_q64_bits: reader.q64(),
    display_price_q64_bits: reader.q64(),
    realizable_value_rao: reader.u64(),
    spot_value_rao: reader.u64(),
    provisional: reader.bool(),
  };
}

function claim(reader: ScaleReader) {
  return {
    hotkey: reader.account(),
    owed_shares_atomic: reader.u64(),
    accrued_rao: reader.u64(),
    redeemable_rao: reader.u64(),
    forfeited_estimate_rao: reader.u64(),
    rows: reader.u32(),
    rows_to_sell: reader.u32(),
    dust_rows: reader.u32(),
    swept_rows: reader.u32(),
    flushed_credits: reader.u32(),
  };
}

export function decodeBasketPricingPage(hex: unknown) {
  const reader = new ScaleReader(hex);
  return RootBasketPricingPageSchema.parse(
    reader.finish({
      pricing: reader.vector(ROOT_BASKET_READ_LIMITS.page, () =>
        pricing(reader),
      ),
      next_after: reader.option(() => reader.account()),
    }),
  );
}

export function decodeBasketPricing(hex: unknown) {
  const reader = new ScaleReader(hex);
  return reader.finish(
    reader.option(() => RootBasketPricingSchema.parse(pricing(reader))),
  );
}

export function decodeBasketSummary(hex: unknown) {
  const reader = new ScaleReader(hex);
  return RootBasketSummarySchema.parse(
    reader.finish({
      hotkey: reader.account(),
      realizable_nav_rao: reader.u64(),
      spot_nav_rao: reader.u64(),
      shares_atomic: reader.u64(),
      deposited_rao: reader.u64(),
      redeemed_rao: reader.u64(),
      holdings: reader.vector(ROOT_BASKET_READ_LIMITS.holdings, () => {
        const netuid = Number(reader.integer(2));
        return {
          netuid,
          quantity_atomic: reader.u64(),
          quantity_unit: netuid === 0 ? "rao" : "alpha_atomic",
          spot_value_rao: reader.u64(),
          realizable_value_rao: reader.u64(),
        };
      }),
    }),
  );
}

export function decodeBasketPosition(hex: unknown) {
  const reader = new ScaleReader(hex);
  return reader.finish(
    reader.option(() => RootBasketPositionSchema.parse(position(reader))),
  );
}

export function decodeBasketPortfolio(hex: unknown) {
  const reader = new ScaleReader(hex);
  return reader.finish(
    reader.vector(ROOT_BASKET_READ_LIMITS.positions, () =>
      RootBasketPositionSchema.parse(position(reader)),
    ),
  );
}

export function decodeBasketClaimPreview(hex: unknown) {
  const reader = new ScaleReader(hex);
  return reader.finish(
    reader.option(() => RootBasketClaimPreviewSchema.parse(claim(reader))),
  );
}

export function decodeBasketClaimPreviews(hex: unknown) {
  const reader = new ScaleReader(hex);
  return reader.finish(
    reader.vector(ROOT_BASKET_READ_LIMITS.positions, () =>
      RootBasketClaimPreviewSchema.parse(claim(reader)),
    ),
  );
}

export function decodeBasketTradingStatus(hex: unknown) {
  const reader = new ScaleReader(hex);
  return RootBasketTradingStatusSchema.parse(
    reader.finish({
      enabled: reader.bool(),
      frozen: reader.bool(),
      refill_blocks: reader.u64(),
      available_rao: reader.u64(),
      budget_rao: reader.u64(),
    }),
  );
}

export function decodeBasketIndex(hex: unknown) {
  const reader = new ScaleReader(hex);
  return RootBasketIndexSchema.parse(
    reader.finish({
      bag_index_q64_bits: reader.q64(),
      stake_index_q64_bits: reader.q64(),
    }),
  );
}

export function decodeBasketStakingHotkeys(hex: unknown): string[] {
  if (hex === null) return [];
  const reader = new ScaleReader(hex);
  const hotkeys = reader.finish(
    reader.vector(ROOT_BASKET_READ_LIMITS.relationships, () =>
      reader.account(),
    ),
  );
  if (new Set(hotkeys).size !== hotkeys.length)
    throw new Error("Duplicate basket staking relationship");
  return hotkeys;
}

export function decodeBasketBaseline(hex: unknown) {
  const schema = RootBasketCaptureSchema.shape.funds.element.shape.baseline;
  if (hex === null)
    return schema.parse({
      provisional: true,
      first_block: "0",
      price_divisor_q64_bits: null,
      rate0_q32_bits: null,
      tr_splice_q64_bits: null,
    });
  const reader = new ScaleReader(hex);
  const divisor = reader.q64();
  let rate = reader.integer(16);
  if (rate >= 1n << 127n) rate -= 1n << 128n;
  return schema.parse(
    reader.finish({
      provisional: false,
      price_divisor_q64_bits: divisor,
      rate0_q32_bits: rate.toString(),
      tr_splice_q64_bits: reader.q64(),
      first_block: reader.u64(),
    }),
  );
}

export function decodeBasketIndexSnapshot(hex: unknown) {
  const schema = RootBasketCaptureSchema.shape.index;
  if (hex === null)
    return schema.parse({
      status: "not_published",
      completed_block: null,
      bag_q64_bits: "18446744073709551616",
      stake_q64_bits: "18446744073709551616",
    });
  const reader = new ScaleReader(hex);
  return schema.parse(
    reader.finish({
      status: "published",
      bag_q64_bits: reader.q64(),
      stake_q64_bits: reader.q64(),
      completed_block: reader.u64(),
    }),
  );
}
