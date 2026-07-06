import { durationLabel } from "./format";

/**
 * Duration text for incident rows: only when `startedAt` is present, using the
 * shared {@link durationLabel} helper (open incidents run elapsed to now).
 */
export function incidentDurationLabel(
  startedAt?: string | null,
  endedAt?: string | null,
): string | null {
  if (!startedAt) return null;
  return durationLabel(startedAt, endedAt);
}
