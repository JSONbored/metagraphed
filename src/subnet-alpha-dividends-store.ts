// The subnet-alpha-dividends store contract (#13163) -- the native seam the
// /subnets/{netuid}/alpha-dividends family reads through. Same shape
// discipline as selectedSubnetMechanismsStore: a key ABSENT from the env means
// "no store", which the builders render as the schema-stable decline; a key
// present with the wrong shape is a configuration error worth throwing on,
// not degrading over.

export interface SubnetAlphaDividendsStore {
  /** One subnet's pending dividend rows, newest accrual first. */
  rows(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetAlphaDividendsStore(
  env: unknown,
): SubnetAlphaDividendsStore | null {
  if (
    !env ||
    typeof env !== "object" ||
    !("SUBNET_ALPHA_DIVIDENDS_STORE" in env)
  )
    return null;
  const store = (env as Record<string, unknown>).SUBNET_ALPHA_DIVIDENDS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native subnet alpha dividends store");
  return store as SubnetAlphaDividendsStore;
}
