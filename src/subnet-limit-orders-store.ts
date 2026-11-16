// The subnet-limit-orders store contract (#13165) -- the native seam the
// /subnets/{netuid}/limit-orders card reads through. Same shape discipline
// as selectedSubnetSwapStore: a key ABSENT from the env means "no store",
// which the builder renders as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface SubnetLimitOrdersStore {
  /** One subnet's order rows, newest capture first, store-capped. */
  rows(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetLimitOrdersStore(
  env: unknown,
): SubnetLimitOrdersStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_LIMIT_ORDERS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_LIMIT_ORDERS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native subnet limit orders store");
  return store as SubnetLimitOrdersStore;
}
