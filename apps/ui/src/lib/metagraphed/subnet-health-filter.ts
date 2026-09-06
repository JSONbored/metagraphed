/** Keep older API-shaped health links aligned with the UI's probe vocabulary. */
export function directoryHealthFilter(value: unknown): string {
  if (value === "degraded") return "warn";
  if (value === "failed") return "down";
  return typeof value === "string" ? value : "";
}
