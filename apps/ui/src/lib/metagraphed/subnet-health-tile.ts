import type { StatPhase } from "./stat-phase";

export type TileTone = "warn" | "down" | "ok" | "accent" | "default";

export interface TileDescriptor {
  phase: StatPhase;
  value: string;
  hint: string;
  tone: TileTone;
}

/**
 * Operational tile decision (subnet-priority-highlights.tsx). The green "ok"
 * tone / "Healthy" value must only come from a resolved query that reports
 * real numeric down/warn counts over a probed (non-zero) total -- a pending
 * or errored query, or a ready query missing those numbers, must never read
 * as "Healthy" (#8816).
 */
export function operationalTileState(input: {
  phase: StatPhase;
  down: number | undefined;
  warn: number | undefined;
  total: number | undefined;
}): TileDescriptor {
  const { phase, down, warn, total } = input;
  if (phase === "pending") {
    return { phase, value: "…", hint: "checking probes", tone: "default" };
  }
  if (phase === "error") {
    return { phase, value: "Unavailable", hint: "health probe unavailable", tone: "default" };
  }
  if (typeof down !== "number" || typeof warn !== "number" || !total) {
    return { phase, value: "—", hint: "no probe data", tone: "default" };
  }
  const incidents = down + warn;
  if (incidents > 0) {
    return {
      phase,
      value: `${incidents} open`,
      hint: `${down} down · ${warn} degraded`,
      tone: down > 0 ? "down" : "warn",
    };
  }
  return { phase, value: "Healthy", hint: "All probed surfaces up", tone: "ok" };
}

/**
 * Curation tile decision. A pending/errored profile query must never default
 * to a specific curation level ("candidate-discovered") -- that is a
 * registry-level claim the UI cannot make on missing data (#8816).
 */
export function curationTileState(input: {
  phase: StatPhase;
  curationLevel: string | null | undefined;
}): TileDescriptor {
  const { phase, curationLevel } = input;
  if (phase === "pending") {
    return { phase, value: "…", hint: "checking curation", tone: "default" };
  }
  if (phase === "error") {
    return { phase, value: "Unavailable", hint: "curation query unavailable", tone: "default" };
  }
  if (curationLevel == null) {
    return { phase, value: "Unknown", hint: "curation level not recorded", tone: "default" };
  }
  const isAdapter = curationLevel === "adapter-backed";
  const label = curationLevel
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
  return {
    phase,
    value: label,
    hint: isAdapter ? "Deep integration — adapter-backed" : "Registry curation level",
    tone: isAdapter ? "accent" : "default",
  };
}
