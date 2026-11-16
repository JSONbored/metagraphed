// The subnet-services store contract (#13164) -- the native seam the
// /subnets/{netuid}/services card reads through. Same shape discipline as
// selectedSubnetGammaStore: a key ABSENT from the env means "no store",
// which the builder renders as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

export interface SubnetServicesStore {
  /** One subnet's service-URL rows, ordered by hotkey. */
  rows(netuid: number): Promise<Record<string, unknown>[]>;
}

export function selectedSubnetServicesStore(
  env: unknown,
): SubnetServicesStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_SERVICES_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_SERVICES_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).rows !== "function"
  )
    throw new TypeError("Invalid native subnet services store");
  return store as SubnetServicesStore;
}
