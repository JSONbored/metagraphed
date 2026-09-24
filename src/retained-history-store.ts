import type { ArtifactStoreEnv } from "./projection-store.ts";
import { type HistoryReadEnv } from "./history-readers.ts";

/** An enabled native history owner remains configured without a SQL token.
 * An artifact bucket alone can contain only registry/build artifacts. */
export function hasRetainedHistoryStore(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
): boolean {
  return env?.NATIVE_PROJECTIONS === "enabled";
}

/** A configured history owner cannot turn an unqualified read into absence. */
export class RetainedHistoryUnavailableError extends Error {
  readonly toolError = true;
  readonly code = "history_unavailable";
  constructor() {
    super("Retained historical data is unavailable. Please retry.");
  }
}

export async function requireRetainedHistoryAnswer<T>(
  env: unknown,
  pending: Promise<T | null | undefined>,
): Promise<T | null | undefined> {
  const answer = await pending;
  if (answer == null && hasRetainedHistoryStore(env as HistoryReadEnv)) {
    throw new RetainedHistoryUnavailableError();
  }
  return answer;
}

/** Preserve callers that already expose an explicit gap or degraded answer. */
export async function declineRetainedHistoryFailure<T>(
  pending: Promise<T>,
): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof RetainedHistoryUnavailableError) return null;
    throw error;
  }
}
