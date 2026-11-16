// The subnet-swap store contract (#13165) -- the native seam the
// /subnets/{netuid}/swap card reads through. Same shape discipline as
// selectedSubnetGammaStore: a key ABSENT from the env means "no store",
// which the builder renders as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface SubnetSwapStore {
  /** One subnet's newest balancer capture -- zero or one rows. */
  latest(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetSwapStore(env: unknown): SubnetSwapStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_SWAP_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_SWAP_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).latest !== "function"
  )
    throw new TypeError("Invalid native subnet swap store");
  return store as SubnetSwapStore;
}
