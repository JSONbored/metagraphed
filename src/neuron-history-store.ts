import type {
  ColdAccountPositionRow,
  ColdNeuronHistoryRow,
} from "./neuron-daily-cold-tier.ts";

export interface NeuronHistoryRange {
  lo: string | null;
  hi: string | null;
}

export interface NeuronHistoryStore {
  neuronRows(
    netuid: number,
    uid: number,
    range: NeuronHistoryRange,
    limit: number,
  ): Promise<ColdNeuronHistoryRow[]>;
  accountRows(
    account: string,
    netuid: number,
    range: NeuronHistoryRange,
    limit: number,
  ): Promise<ColdAccountPositionRow[]>;
}

export function selectedNeuronHistoryStore(
  env: unknown,
): NeuronHistoryStore | null {
  if (!env || typeof env !== "object" || !("NEURON_HISTORY_STORE" in env))
    return null;
  const store = env.NEURON_HISTORY_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("neuronRows" in store) ||
    typeof store.neuronRows !== "function" ||
    !("accountRows" in store) ||
    typeof store.accountRows !== "function"
  )
    throw new TypeError("Invalid native neuron history store");
  return store as NeuronHistoryStore;
}
