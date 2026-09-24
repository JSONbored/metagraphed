// D1 owns both preserved daily history and actual current probe readings.
import { createD1Sql, selectedD1Store } from "./d1-store.ts";
import { SELF_HEALTH_TABLES } from "./self-health-store.ts";
import { loadSelfHealthNeon } from "./self-health-neon.ts";
import type { buildSelfHealth } from "./self-health.ts";
import type { HistoryReadEnv } from "./history-readers.ts";

export async function loadSelfHealthColdTier(
  env: HistoryReadEnv | null | undefined,
  nowMs: number = Date.now(),
): Promise<ReturnType<typeof buildSelfHealth> | null> {
  try {
    const store = selectedD1Store(env, SELF_HEALTH_TABLES);
    return store
      ? await loadSelfHealthNeon(createD1Sql(store), () => nowMs)
      : null;
  } catch {
    return null;
  }
}
