export interface NeuronDailyRollup extends Record<string, unknown> {
  snapshot_date: string;
  neuron_count: string | number;
  validator_count: string | number;
  total_stake_tao: string | number | null;
  total_emission_tao: string | number | null;
}
export interface DirectoryNominatorRow extends Record<string, unknown> {
  hotkey: string;
  nominator_count: number | null;
  scan_at: number | null;
}
export interface NeuronSummaryStore {
  completeRows(): Promise<Record<string, unknown>[]>;
  nominatorCounts(hotkeys: readonly string[]): Promise<DirectoryNominatorRow[]>;
  dailyValidators(
    startDate: string,
    endDate: string,
  ): Promise<Record<string, unknown>[]>;
  dailyTotals(startDate: string, endDate: string): Promise<NeuronDailyRollup[]>;
  subnetHistory(
    netuid: number,
    cutoff: string | null,
    limit: number,
    before?: string | null,
  ): Promise<NeuronDailyRollup[]>;
}
export function selectedNeuronSummaryStore(
  env: unknown,
): NeuronSummaryStore | null {
  if (!env || typeof env !== "object" || !("NEURON_SUMMARY_STORE" in env))
    return null;
  const store = env.NEURON_SUMMARY_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    ![
      "completeRows",
      "nominatorCounts",
      "dailyValidators",
      "dailyTotals",
      "subnetHistory",
    ].every(
      (name) => typeof (store as Record<string, unknown>)[name] === "function",
    )
  )
    throw new TypeError("Invalid native neuron summary store");
  return store as NeuronSummaryStore;
}
