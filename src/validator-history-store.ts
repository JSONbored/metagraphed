export interface ValidatorHistoryStore {
  rows(
    hotkey: string,
    cutoff: string | null,
    limit: number,
    netuid?: number,
  ): Promise<Record<string, unknown>[]>;
}
export function selectedValidatorHistoryStore(
  env: unknown,
): ValidatorHistoryStore | null {
  if (!env || typeof env !== "object" || !("VALIDATOR_HISTORY_STORE" in env))
    return null;
  const store = env.VALIDATOR_HISTORY_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("rows" in store) ||
    typeof store.rows !== "function"
  )
    throw new TypeError("Invalid native validator history store");
  return store as ValidatorHistoryStore;
}
