// Single source of truth for the health-status color CSS custom properties.
// styles.css (and the runtime palette in health-palette.ts) owns the real token
// values; a `var(--health-*, <fallback>)` reference only uses the fallback hex on
// the vanishingly rare occasion the token is absent — it is otherwise inert.
//
// Consumers (endpoint-list, subnet-history-chart, subnet-price-ticker,
// health-segments, …) each previously re-declared their OWN fallback hex for the
// same token, and those hexes disagreed (#3458): `--health-ok` was written as
// `#16a34a`, `#4ade80`, and `#22c55e` across files. This centralizes one agreed
// fallback per tier so they can never drift again.

export type HealthTone = "ok" | "warn" | "down" | "unknown";

/** The one agreed fallback hex per health tier (Tailwind 500 / slate-400). */
export const HEALTH_TOKEN_FALLBACK: Record<HealthTone, string> = {
  ok: "#22c55e",
  warn: "#f59e0b",
  down: "#ef4444",
  unknown: "#94a3b8",
};

/** `var(--health-<tone>, <fallback>)` — the canonical color reference for a tier. */
export function healthColorVar(tone: HealthTone): string {
  return `var(--health-${tone}, ${HEALTH_TOKEN_FALLBACK[tone]})`;
}
