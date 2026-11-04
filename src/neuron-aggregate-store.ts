export interface NeuronAggregateStore {
  aggregateRows(): Promise<Record<string, unknown>[]>;
}

export function selectedNeuronAggregateStore(
  env: unknown,
): NeuronAggregateStore | null {
  if (!env || typeof env !== "object" || !("NEURON_AGGREGATE_STORE" in env))
    return null;
  const store = env.NEURON_AGGREGATE_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("aggregateRows" in store) ||
    typeof store.aggregateRows !== "function"
  )
    throw new TypeError("Invalid native neuron aggregate store");
  return store as NeuronAggregateStore;
}
