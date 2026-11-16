export interface ChainConcentrationRecord {
  day: string;
  neuronCount: number;
  card: string;
  capturedAt: number | null;
  computedAt: number;
  builderVersion: number;
}

export interface ChainConcentrationStore {
  pendingDays(beforeDay: string, limit: number): Promise<string[]>;
  dailyRows(day: string): Promise<Record<string, unknown>[]>;
  put(record: ChainConcentrationRecord): Promise<void>;
}

export function selectedChainConcentrationStore(
  env: unknown,
): ChainConcentrationStore | null {
  if (!env || typeof env !== "object" || !("CHAIN_CONCENTRATION_STORE" in env))
    return null;
  const store = env.CHAIN_CONCENTRATION_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !["pendingDays", "dailyRows", "put"].every(
      (name) => typeof Reflect.get(store, name) === "function",
    )
  )
    throw new TypeError("Native chain concentration capability is incomplete");
  return store as ChainConcentrationStore;
}
