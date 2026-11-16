export interface NeuronDirectoryRow extends Record<string, unknown> {
  hotkey: string;
}

export interface NeuronLiveStore {
  newestCapture(): Promise<number>;
  economicsRows(netuid?: number): Promise<Record<string, unknown>[]>;
  directoryRows(validatorsOnly?: boolean): Promise<NeuronDirectoryRow[]>;
}

export const NEURON_ECONOMICS_FIELDS = [
  "stake_tao",
  "validator_permit",
  "dividends",
  "active",
  "take",
] as const;

export function selectedNeuronLiveStore(env: unknown): NeuronLiveStore | null {
  if (!env || typeof env !== "object" || !("NEURON_LIVE_STORE" in env))
    return null;
  const store = env.NEURON_LIVE_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !["newestCapture", "economicsRows", "directoryRows"].every(
      (name) => typeof (store as Record<string, unknown>)[name] === "function",
    )
  )
    throw new TypeError("Invalid native neuron live store");
  return store as NeuronLiveStore;
}
