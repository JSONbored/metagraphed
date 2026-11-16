// The subnet-gamma store contract (#13164) -- the native seam the Gamma
// route family (/subnets/{netuid}/gamma, its /history, /chain/gamma) reads
// through. Same shape discipline as selectedSubnetMechanismsStore: a key
// ABSENT from the env means "no store", which the builders render as the
// schema-stable decline; a key present with the wrong shape is a
// configuration error worth throwing on, not degrading over.

export interface SubnetGammaStore {
  /** One subnet's newest Gamma capture -- zero or one rows. */
  latest(netuid: number): Promise<Record<string, unknown>[]>;
  /** One subnet's Gamma capture series, newest first, store-capped. */
  history(netuid: number): Promise<Record<string, unknown>[]>;
  /** The newest Gamma capture of every subnet, ordered by netuid. */
  chain(): Promise<Record<string, unknown>[]>;
  /** The newest global GammaEnabled capture -- zero or one rows. */
  enabled(): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetGammaStore(
  env: unknown,
): SubnetGammaStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_GAMMA_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_GAMMA_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).latest !== "function" ||
    typeof (store as Record<string, unknown>).history !== "function" ||
    typeof (store as Record<string, unknown>).chain !== "function" ||
    typeof (store as Record<string, unknown>).enabled !== "function"
  )
    throw new TypeError("Invalid native subnet gamma store");
  return store as SubnetGammaStore;
}
