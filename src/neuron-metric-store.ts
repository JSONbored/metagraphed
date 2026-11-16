export interface NeuronMetricStore {
  performanceRows(): Promise<Record<string, unknown>[]>;
  dailyRows<Row>(
    netuid: number,
    cutoff: string | null,
    columns: readonly string[],
    limit: number,
  ): Promise<Row[]>;
}

export function selectedNeuronMetricStore(
  env: unknown,
): NeuronMetricStore | null {
  if (!env || typeof env !== "object" || !("NEURON_METRIC_STORE" in env))
    return null;
  const store = env.NEURON_METRIC_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("performanceRows" in store) ||
    typeof store.performanceRows !== "function" ||
    !("dailyRows" in store) ||
    typeof store.dailyRows !== "function"
  )
    throw new TypeError("Invalid native neuron metric store");
  return store as NeuronMetricStore;
}
