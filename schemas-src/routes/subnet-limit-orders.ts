// GET /api/v1/subnets/{netuid}/limit-orders (#13165; #13161, epic #13142).
// One subnet's LimitOrders order book, served live from app.limit_orders
// (migration 0050) through the native store seam. The table's writers -- the
// engine's LimitOrders.Orders / LimitOrders.ApprovedOrders decode -- land
// separately, so until a store is bound and filled this route serves the
// schema-stable decline below, never a fabricated order-less subnet.
import { z } from "zod";

export const SubnetLimitOrderSchema = z
  .object({
    order_id: z
      .string()
      .describe(
        "The chain's H256 order key (LimitOrders.Orders) as 0x-prefixed lowercase hex.",
      ),
    owner: z
      .string()
      .describe("The account that placed the order (ss58-encoded)."),
    kind: z
      .string()
      .describe(
        "The chain's OrderType variant, spelled as the chain spells it -- a pinned enum would reject a variant the runtime adds.",
      ),
    amount: z
      .string()
      .nullable()
      .describe(
        "The order's amount -- u64 atomic units as a decimal string. Null when the capture did not carry it, never fabricated as 0.",
      ),
    price: z
      .string()
      .nullable()
      .describe(
        "The order's limit price -- the chain's raw price encoding as a canonical decimal string, served verbatim because the engine's decode owns the scaling. Null when not captured.",
      ),
    status: z
      .string()
      .nullable()
      .describe(
        "The order's state (LimitOrders.Orders: Fulfilled / PartiallyFilled / Cancelled today), spelled as the chain spells it. Null when the capture did not carry one -- never a fabricated open order.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured limit order: its chain key, owner, type, amount, raw price and state with their capture stamp.",
  );

export const SubnetLimitOrdersArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * book is never a measured "no orders" -- it is what an unbound or
     * unfilled store looks like (the engine dependency #13165 defers), and
     * publishing it as a count would be the confident-zero failure the
     * sibling subnet surfaces' own comments are about.
     */
    order_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many orders this answer carries -- `orders.length`, store-capped. NULL when the book holds no rows for this subnet (store unbound, or the order-book capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    orders: z
      .array(SubnetLimitOrderSchema)
      .describe("The subnet's captured orders, newest capture first."),
  })
  .strict()
  .describe(
    "One subnet's LimitOrders order book (#13165). Empty with a null order_count until the engine's order-book capture lands. Mirrors GET /api/v1/subnets/{netuid}/limit-orders.",
  );
