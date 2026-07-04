export function normalizeDriftStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

export function isSchemaDrift(value: unknown): boolean {
  const driftStatus = normalizeDriftStatus(value);
  return driftStatus != null && driftStatus !== "unchanged" && driftStatus !== "new";
}
