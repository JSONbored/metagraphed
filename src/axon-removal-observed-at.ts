/** Daily transition dates denote UTC midnight; legacy event rows use epoch ms. */
export function axonObservationEpochMs(value: unknown): number | null {
  if (value == null) return null;
  const daily = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const epoch = daily ? Date.parse(`${value}T00:00:00.000Z`) : Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) return null;
  // Date.parse normalizes impossible dates such as February 30. Reject them.
  if (daily && date.toISOString().slice(0, 10) !== value) return null;
  return epoch;
}

export function axonObservationIso(value: unknown): string | null {
  const epoch = axonObservationEpochMs(value);
  return epoch == null ? null : new Date(epoch).toISOString();
}
