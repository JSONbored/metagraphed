// The subnet-limit-orders serving builders (#13165) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces
// cannot drift. Pure + exported for tests; callers resolve the store (the
// native seam in subnet-limit-orders-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The order book's writers -- the engine's
// LimitOrders.Orders / LimitOrders.ApprovedOrders decode -- land separately
// (#13165 defers them), so an empty result is not "this subnet has no limit
// orders": it is "the order-book capture has not run", and
// `order_count: null` with an empty `orders` is how the artifact says so.
// Amounts are u64 atomic units as decimal strings; price crosses verbatim as
// the chain's raw encoding in decimal text, because re-scaling it here would
// invent precision the decode owns.
import { selectedSubnetLimitOrdersStore } from "./subnet-limit-orders-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";
import { u128TextOrNull } from "./subnet-gamma.ts";

type Row = Record<string, unknown>;

const ORDER_ID_PATTERN = /^0x[0-9a-f]{64}$/;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A non-empty stored label (kind/status/owner), or null. */
function labelOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** One stored order row to its published shape, or null when the row names
 * no order the chain defines (no id, owner or kind to act on). */
export function formatLimitOrder(row: Row): Row | null {
  const orderId =
    typeof row?.order_id === "string" && ORDER_ID_PATTERN.test(row.order_id)
      ? row.order_id
      : null;
  const owner = labelOrNull(row?.owner);
  const kind = labelOrNull(row?.kind);
  if (orderId === null || owner === null || kind === null) return null;
  return {
    order_id: orderId,
    owner,
    kind,
    amount: u64TextOrNull(row?.amount),
    price: u128TextOrNull(row?.price),
    status: labelOrNull(row?.status),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetLimitOrders(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const orders = (rows ?? [])
    .map((row) => formatLimitOrder(row))
    .filter((row): row is Row => row !== null);
  // Newest stamp across the rows: the book is written per order, so one
  // capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const order of orders) {
    const stamp = order.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    netuid,
    order_count: orders.length > 0 ? orders.length : null,
    captured_at: newest,
    orders,
  };
}

/**
 * One subnet's order rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetLimitOrders(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetLimitOrdersStore(env);
  if (!store) return null;
  try {
    return await store.rows(netuid);
  } catch (error) {
    console.error("subnet limit orders store read failed:", error);
    return null;
  }
}
