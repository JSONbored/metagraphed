export interface NeuronDailyViewQuery {
  columns: readonly string[];
  netuid?: number;
  fromDay?: string | null;
  beforeDay?: string | null;
  days?: readonly string[];
  oldestFirst?: boolean;
  limit: number;
}
export interface NeuronDailyViewStore {
  rows(query: NeuronDailyViewQuery): Promise<Record<string, unknown>[]>;
  window(
    days: number | null,
    netuid?: number,
  ): Promise<{
    startDate: string | null;
    endDate: string | null;
  }>;
}
export function selectedNeuronDailyViewStore(
  env: unknown,
): NeuronDailyViewStore | null {
  if (!env || typeof env !== "object" || !("NEURON_DAILY_VIEW_STORE" in env))
    return null;
  const store = env.NEURON_DAILY_VIEW_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("rows" in store) ||
    typeof store.rows !== "function" ||
    !("window" in store) ||
    typeof store.window !== "function"
  )
    throw new TypeError("Invalid native neuron daily view store");
  return store as NeuronDailyViewStore;
}
