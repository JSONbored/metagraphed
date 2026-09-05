// Internal observation contract; no public route or publication pointer.
// SCALE types are pinned to subtensor 14cde6410fe8ec81a940e290c56f94a632a0988d
// (v454), rpc_info/basket_info.rs and staking/beta_pricing.rs.
import { z } from "zod";
import { BittensorNetworkSchema } from "./shared.ts";

function integerString(bits: number, signed = false) {
  const bound = 1n << BigInt(signed ? bits - 1 : bits);
  return z
    .string()
    .max(signed ? 40 : 39)
    .regex(signed ? /^(0|[1-9]\d*|-[1-9]\d*)$/ : /^(0|[1-9]\d*)$/)
    .pipe(
      z.string().refine(
        (value) => {
          const integer = BigInt(value);
          return integer >= (signed ? -bound : 0n) && integer < bound;
        },
        `Outside ${signed ? "i" : "u"}${bits} range`,
      ),
    );
}

const u64 = integerString(64);
const q64 = integerString(128);
const i128 = integerString(128, true);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const account = hash;
const count = z.int().min(0).max(4_294_967_295);
const netuid = z.int().min(0).max(65_535);
const oneQ64 = "18446744073709551616";

function greaterUnsigned(left: string, right: string): boolean {
  // Object refinements can still run after a scalar validation issue.
  // Compare only validated quantities so safeParse never throws on bad input.
  const a = u64.safeParse(left);
  const b = u64.safeParse(right);
  return a.success && b.success && BigInt(a.data) > BigInt(b.data);
}

const holding = z
  .object({
    netuid,
    quantity_atomic: u64,
    // Root cash uses rao; every other quantity belongs to its own subnet.
    quantity_unit: z.enum(["rao", "alpha_atomic"]),
    spot_value_rao: u64,
    realizable_value_rao: u64,
  })
  .strict()
  .refine(
    (row) => (row.netuid === 0) === (row.quantity_unit === "rao"),
    "Only netuid 0 holds rao; other quantities are subnet alpha atoms",
  );

const target = z.object({ netuid, weight: netuid }).strict();
const baseline = z.discriminatedUnion("provisional", [
  z
    .object({
      provisional: z.literal(true),
      first_block: z.literal("0"),
      price_divisor_q64_bits: z.null(),
      rate0_q32_bits: z.null(),
      tr_splice_q64_bits: z.null(),
    })
    .strict(),
  z
    .object({
      provisional: z.literal(false),
      first_block: u64.refine((value) => value !== "0"),
      price_divisor_q64_bits: q64.refine((value) => value !== "0"),
      rate0_q32_bits: i128,
      tr_splice_q64_bits: q64.refine((value) => value !== "0"),
    })
    .strict(),
]);

const fund = z
  .object({
    hotkey: account,
    page_index: count,
    shares_atomic: u64.refine((value) => value !== "0"),
    spot_nav_rao: u64,
    realizable_nav_rao: u64,
    deposited_rao: u64,
    redeemed_rao: u64,
    raw_spot_price_q64_bits: q64,
    display_price_q64_bits: q64,
    // Quantity, not price: human display beta = bits / (2^64 * 10^9).
    display_shares_q64_bits: q64,
    stake_price_q64_bits: q64,
    staker_twr_q64_bits: q64,
    // The runtime's staker_yield field is a mark, not an annualized return.
    pending_entitlement_q64_bits: q64,
    baseline,
    // Required arrays: [] is a complete empty part; missing is invalid.
    holdings: z.array(holding).max(65_536),
    targets: z.array(target).max(65_536),
  })
  .strict();

const page = z
  .object({
    page_index: count,
    start_after: account.nullable(),
    next_after: account.nullable(),
    response_sha256: hash,
    fund_count: z.int().min(0).max(256),
  })
  .strict();

const index = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("published"),
      completed_block: u64,
      bag_q64_bits: q64,
      stake_q64_bits: q64,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_published"),
      completed_block: z.null(),
      bag_q64_bits: z.literal(oneQ64),
      stake_q64_bits: z.literal(oneQ64),
    })
    .strict(),
]);

/** A complete source observation, not proof its rows have been persisted.
 * All reads use the same finalized hash. Persistence must later verify every
 * receipt and child row before advertising completeness; this slice serves none.
 * The capture/address key deliberately makes no claim about immutable fund life.
 */
export const RootBasketCaptureSchema = z
  .object({
    capture_id: z.uuid(),
    network: BittensorNetworkSchema,
    network_genesis_hash: hash,
    finalized_block_hash: hash,
    finalized_block: u64,
    runtime_spec_version: z.literal(454),
    runtime_api_version: z.literal(3),
    decoder_version: z.literal("subtensor-v454-14cde641-v1"),
    metadata_sha256: hash,
    started_at_ms: u64,
    finished_at_ms: u64,
    expected_pages: count.min(1),
    expected_funds: count,
    index,
    pages: z.array(page).min(1),
    funds: z.array(fund),
  })
  .strict()
  .superRefine((capture, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (greaterUnsigned(capture.started_at_ms, capture.finished_at_ms)) {
      issue("Capture finish precedes start");
    }
    if (
      capture.index.completed_block !== null &&
      greaterUnsigned(capture.index.completed_block, capture.finalized_block)
    ) {
      issue("Index completion is after the finalized source block");
    }
    if (
      capture.pages.length !== capture.expected_pages ||
      capture.funds.length !== capture.expected_funds
    ) {
      issue("Manifest counts do not match the observed rows");
    }
    const fundCounts = new Map<number, number>();
    for (const row of capture.funds) {
      fundCounts.set(row.page_index, (fundCounts.get(row.page_index) ?? 0) + 1);
    }
    const seenCursors = new Set<string>();
    for (const [position, row] of capture.pages.entries()) {
      const expectedStart =
        position === 0 ? null : capture.pages[position - 1]!.next_after;
      if (
        row.page_index !== position ||
        row.start_after !== expectedStart ||
        (position > 0 && row.start_after === null) ||
        (position === capture.pages.length - 1) !== (row.next_after === null)
      ) {
        issue(
          "Pagination must form one contiguous chain ending in a terminal receipt",
        );
      }
      if (row.next_after !== null) {
        if (seenCursors.has(row.next_after))
          issue("Pagination repeated a cursor");
        seenCursors.add(row.next_after);
      }
      if ((fundCounts.get(position) ?? 0) !== row.fund_count) {
        issue("Receipt fund count does not match its observations");
      }
    }
    const seenFunds = new Set<string>();
    for (const row of capture.funds) {
      if (seenFunds.has(row.hotkey))
        issue("Duplicate fund address within a capture");
      seenFunds.add(row.hotkey);
      if (row.page_index >= capture.pages.length)
        issue("Fund references an absent receipt");
      if (greaterUnsigned(row.baseline.first_block, capture.finalized_block)) {
        issue("Baseline stamp is after the finalized source block");
      }
      for (const part of [row.holdings, row.targets]) {
        if (new Set(part.map((entry) => entry.netuid)).size !== part.length) {
          issue("Duplicate netuid within a complete fund part");
        }
      }
    }
  });
