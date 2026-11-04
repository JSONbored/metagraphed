export interface NeuronSnapshotStore {
  subnetRows(netuid: number, validatorsOnly: boolean): Promise<Record<string, unknown>[]>;
  burnHotkey(netuid: number): Promise<string | null>;
}

export function selectedNeuronSnapshotStore(env: unknown): NeuronSnapshotStore | null {
  if (!env || typeof env !== "object" || !("NEURON_SNAPSHOT_STORE" in env)) return null;
  const store = env.NEURON_SNAPSHOT_STORE;
  if (!store || typeof store !== "object" || !("subnetRows" in store) || typeof store.subnetRows !== "function" ||
      !("burnHotkey" in store) || typeof store.burnHotkey !== "function")
    throw new TypeError("Invalid native neuron snapshot store");
  return store as NeuronSnapshotStore;
}
