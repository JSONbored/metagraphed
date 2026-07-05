/** Canonical inline health color tokens (defined in styles.css). */
export const HEALTH_COLOR = {
  ok: "var(--health-ok)",
  warn: "var(--health-warn)",
  down: "var(--health-down)",
  unknown: "var(--health-unknown)",
} as const;

export const INK_MUTED_COLOR = "var(--ink-muted)";

export function healthStateInlineColor(state?: string): string {
  const s = state ?? "unknown";
  if (s === "ok") return HEALTH_COLOR.ok;
  if (s === "warn" || s === "degraded") return HEALTH_COLOR.warn;
  if (s === "down" || s === "offline") return HEALTH_COLOR.down;
  return HEALTH_COLOR.unknown;
}
