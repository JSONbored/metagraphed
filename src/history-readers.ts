import type { TelemetryEnv } from "./usage-telemetry.ts";
/** Native historical storage selection shared by reader entry points. */
export interface HistoryReadEnv extends TelemetryEnv {
  D1_STATE?: unknown;
  D1_STATE_TABLES?: string;
  NATIVE_PROJECTIONS?: string;
  D1_RETAINED_BLOCKS?: import("./d1-store.ts").D1StoreBinding;
  RETAINED_BLOCKS_NETWORKS?: string;
}
/** Explicit offline/producer query seam; there is no request-time transport. */
export type HistoricalQueryReader = (
  env: HistoryReadEnv | null | undefined,
  sql: string,
  deps?: { timeoutMs?: number },
) => Promise<Record<string, unknown>[] | null>;
export const HISTORY_READ_TIMEOUT_MS = 15_000;
/** Accept a real non-negative block height without coercing missing values. */
export function safeBlockNumber(value: unknown): number | null {
  // Number() coerces null -> 0, "" -> 0, false -> 0 and true -> 1, every one
  // of which is a "valid" height. Without this guard a missing or malformed
  // parameter would silently resolve to block 0 (or 1) and serve the wrong
  // block confidently. Accept only a real number, or a string that is
  // entirely digits.
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** An SS58 address that is safe to inline: only the base58 alphabet, at the
 * lengths Substrate addresses actually take. Refused rather than escaped, for
 * the same reason as the other literal guards here. */
export function safeSs58Literal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[1-9A-HJ-NP-Za-km-z]{47,49}$/.test(value) ? value : null;
}

/** A bare SQL identifier value (a pallet or call name). These reach a
 * string-built query as VALUES, not as identifiers, but the character set is
 * still constrained to what the chain actually emits so nothing else can be
 * smuggled through. */
export function safeNameLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
}

/** A 0x-prefixed hex hash that is safe to inline. Anything else is refused
 * rather than escaped — this codebase's hashes are always plain hex, so a
 * value that is not is a bug or an attack, and neither should reach the
 * engine. */
export function safeHexLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^0x[0-9a-fA-F]{1,128}$/.test(value) ? value.toLowerCase() : null;
}

/** A `YYYY-MM-DD` day that is safe to inline, refused rather than escaped like
 * every other guard here.
 *
 * SHAPE IS NOT ENOUGH, so this also checks the date EXISTS. `2026-02-31` and
 * `2026-13-01` both satisfy the obvious regex and neither is a day; round-
 * tripping through Date is what rejects them. A nonsense date reaching the
 * engine would not be an injection, but it would silently match no rows, and
 * "no rows" is indistinguishable from "no history" at the seam this feeds --
 * which is the failure mode the whole cold tier exists to avoid.
 *
 * Deliberately NOT a range check. The lakehouse's own floor moves, and pinning
 * a plausible window here would be a second seam constant to forget. */
export function safeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Date rolls an out-of-range component over (Feb 31 -> Mar 3) rather than
  // failing, so the only way to know the input was a real day is to ask what
  // it came back as.
  return parsed.toISOString().slice(0, 10) === day ? day : null;
}
