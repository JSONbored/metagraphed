// The subnet-mechanisms store contract (#13162) -- the native seam the
// /subnets/{netuid}/mechanisms family reads through. Same shape discipline as
// selectedNeuronLiveStore: a key ABSENT from the env means "no store", which
// the builders render as the schema-stable decline; a key present with the
// wrong shape is a configuration error worth throwing on, not degrading over.

export interface SubnetMechanismsStore {
  /** One subnet's mechanism rows, ordered by mechid. */
  rows(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetMechanismsStore(
  env: unknown,
): SubnetMechanismsStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_MECHANISMS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_MECHANISMS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native subnet mechanisms store");
  return store as SubnetMechanismsStore;
}
