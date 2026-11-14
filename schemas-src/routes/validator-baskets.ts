// GET /api/v1/chain/baskets and /api/v1/validators/{hotkey}/basket (#13163;
// #13161, epic #13142). The Root basket capture family
// (app.root_basket_captures / fund_snapshots / holdings / targets, migrations
// 0020/0021/0046) has been stored but unserved: these artifacts serve the
// newest completed finney capture through the ROOT_BASKET_STORE seam. No
// store bound -- or no completed capture yet -- is the schema-stable decline
// below. Quantities stay the canonical decimal text the capture lane stores
// (u64 rao / alpha atomic; Q64.64 bits as u128), never rounded through a
// float.
import { z } from "zod";

export const BasketCaptureSchema = z
  .object({
    finalized_block: z
      .string()
      .describe(
        "The finalized block height the capture observed, as a u64 decimal string.",
      ),
    finalized_block_hash: z.string(),
    runtime_spec_version: z
      .int()
      .min(0)
      .describe(
        "The node-subtensor specVersion the capture was decoded under (454 for the audited legacy decoder; 490-era captures land with the engine's decoder).",
      ),
    decoder_version: z.string(),
    accepted_at: z
      .string()
      .nullable()
      .describe(
        "When the receiver accepted the completed capture. Null when the acceptance stamp did not cross as a readable time.",
      ),
  })
  .strict()
  .describe(
    "The completed Root basket capture an artifact was served from: its finalized source block, runtime era and acceptance stamp.",
  );

export const ValidatorBasketSchema = z
  .object({
    hotkey: z
      .string()
      .nullable()
      .describe(
        "The fund's validator hotkey as a finney SS58 address. Null only when the stored account id could not be re-encoded.",
      ),
    account_id: z
      .string()
      .describe("The fund's validator hotkey as the raw 0x account-id hex."),
    shares_atomic: z.string().nullable(),
    spot_nav_rao: z
      .string()
      .nullable()
      .describe("Spot net asset value in rao, as a u64 decimal string."),
    realizable_nav_rao: z.string().nullable(),
    deposited_rao: z.string().nullable(),
    redeemed_rao: z.string().nullable(),
    display_price_q64_bits: z
      .string()
      .nullable()
      .describe(
        "Display share price as raw Q64.64 bits (u128 decimal string) -- divide by 2^64 for the human price. Served as bits so no precision is invented.",
      ),
    stake_price_q64_bits: z.string().nullable(),
    staker_twr_q64_bits: z
      .string()
      .nullable()
      .describe(
        "The runtime's staker time-weighted-return mark as raw Q64.64 bits. A mark, not an annualized return.",
      ),
    pending_entitlement_q64_bits: z.string().nullable(),
    provisional: z
      .boolean()
      .nullable()
      .describe(
        "Whether the fund's pricing baseline is still provisional (no first_block stamped yet).",
      ),
    first_block: z
      .string()
      .nullable()
      .describe(
        "The baseline's first block as a u64 decimal string; null while the baseline is provisional.",
      ),
    holdings_count: z.int().min(0).nullable(),
    targets_count: z.int().min(0).nullable(),
  })
  .strict()
  .describe(
    "One validator's Root basket fund at the served capture: shares, NAV, deposit/redemption watermarks, pricing marks and baseline state.",
  );

export const BasketHoldingSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    quantity_atomic: z.string().nullable(),
    quantity_unit: z
      .enum(["rao", "alpha_atomic"])
      .nullable()
      .describe(
        "rao for the netuid-0 cash leg; alpha_atomic for every subnet holding.",
      ),
    spot_value_rao: z.string().nullable(),
    realizable_value_rao: z.string().nullable(),
  })
  .strict()
  .describe("One holding leg of a validator's basket at the served capture.");

export const BasketTargetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    weight: z.int().min(0).max(65535),
  })
  .strict()
  .describe("One target-allocation entry of a validator's basket.");

export const ValidatorBasketsArtifactSchema = z
  .object({
    schema_version: z.int(),
    /**
     * NULL capture IS the decline. A completed capture is a verified complete
     * enumeration of every fund, so with a capture present `fund_count: 0`
     * would be a real measurement -- but with no capture (store unbound, or
     * the capture lane has not completed one) a zero would be fabricated.
     */
    capture: BasketCaptureSchema.nullable(),
    fund_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "How many funds the served capture holds -- `baskets.length`. NULL when no completed capture is available to serve (store unbound, or none accepted yet); 0 only as a real measurement from a completed capture.",
      ),
    baskets: z
      .array(ValidatorBasketSchema)
      .describe("The capture's funds, largest spot NAV first."),
  })
  .strict()
  .describe(
    "Every validator's Root basket fund at the newest completed capture (#13163). Empty with a null capture until the capture lane has completed one. Mirrors GET /api/v1/chain/baskets.",
  );

export const ValidatorBasketArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string().describe("The requested validator hotkey (SS58)."),
    capture: BasketCaptureSchema.nullable(),
    /**
     * basket null with a NON-null capture is a measurement: the completed
     * capture enumerates every fund, and this hotkey holds none. basket null
     * with a null capture is the decline.
     */
    basket: ValidatorBasketSchema.nullable(),
    holdings: z
      .array(BasketHoldingSchema)
      .describe("The basket's holding legs, ordered by netuid."),
    targets: z
      .array(BasketTargetSchema)
      .describe("The basket's target allocations, ordered by netuid."),
  })
  .strict()
  .describe(
    "One validator's Root basket fund with its holdings and target allocations at the newest completed capture (#13163). basket is null with a present capture when the capture holds no fund for the hotkey (a measurement), and null with a null capture when there is nothing to serve (the decline). Mirrors GET /api/v1/validators/{hotkey}/basket.",
  );
