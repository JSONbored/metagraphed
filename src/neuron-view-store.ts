export interface NeuronViewQuery {
  columns: readonly string[];
  netuid?: number;
  uid?: number;
  hotkey?: string;
  validatorsOnly?: boolean;
  excludeRoot?: boolean;
  order?: readonly { column: string; descending?: boolean }[];
  limit?: number;
}
export interface NeuronViewStore {
  rows(query: NeuronViewQuery): Promise<Record<string, unknown>[]>;
}
export function selectedNeuronViewStore(env: unknown): NeuronViewStore | null {
  if (!env || typeof env !== "object" || !("NEURON_VIEW_STORE" in env))
    return null;
  const store = env.NEURON_VIEW_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("rows" in store) ||
    typeof store.rows !== "function"
  )
    throw new TypeError("Invalid native neuron view store");
  return store as NeuronViewStore;
}
