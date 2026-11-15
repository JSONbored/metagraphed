// The evm-associations store contract (#13165) -- the native seam the
// /evm/address/{h160} route reads through for the on-chain
// SubtensorModule.AssociatedEvmAddress state. Same shape discipline as
// selectedSubnetSwapStore: a key ABSENT from the env means "no store", which
// the route renders as the precompile-only answer with the schema-stable
// association decline; a key present with the wrong shape is a configuration
// error worth throwing on, not degrading over.

export interface EvmAssociationsStore {
  /** One H160's association rows, newest capture first, store-capped. */
  byH160(h160: string): Promise<Record<string, unknown>[]>;
}

export function selectedEvmAssociationsStore(
  env: unknown,
): EvmAssociationsStore | null {
  if (!env || typeof env !== "object" || !("EVM_ASSOCIATIONS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).EVM_ASSOCIATIONS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    typeof (store as Record<string, unknown>).byH160 !== "function"
  )
    throw new TypeError("Invalid native evm associations store");
  return store as EvmAssociationsStore;
}
