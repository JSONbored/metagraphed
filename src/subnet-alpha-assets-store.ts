// The subnet-alpha-assets store contract (#13165) -- the native seam the
// /subnets/{netuid}/alpha-assets card reads through. Same shape discipline
// as selectedSubnetSwapStore: a key ABSENT from the env means "no store",
// which the builder renders as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface SubnetAlphaAssetsStore {
  /** One subnet's newest alpha-asset capture -- zero or one rows. */
  latest(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetAlphaAssetsStore(
  env: unknown,
): SubnetAlphaAssetsStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_ALPHA_ASSETS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_ALPHA_ASSETS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).latest !== "function"
  )
    throw new TypeError("Invalid native subnet alpha assets store");
  return store as SubnetAlphaAssetsStore;
}
