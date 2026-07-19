// #6884: pure coordinate/scaling math for the /subnets bubble view, extracted
// from subnets-bubble-view.tsx so the division / clamping / date logic is
// unit-testable in a node env without pulling in the React + SVG graph.
import { healthColorVar } from "@/lib/health-tokens";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

export const FINNEY_BLOCK_SECONDS = 12;
export const SECONDS_PER_DAY = 86_400;

// SVG viewBox + inner padding + bubble radius range (shared with the component).
export const BUBBLE_VB = { w: 900, h: 460 } as const;
export const BUBBLE_PAD = { top: 20, right: 24, bottom: 44, left: 56 } as const;
const R_MIN = 4;
const R_MAX = 15;

/**
 * Whole days since a subnet registered, from its registration block and the
 * snapshot's current block at ~12s/block. Returns null when either block is
 * missing / non-finite or the registration block is ahead of the current one, so
 * the caller can drop the point rather than plot a nonsensical negative age.
 */
export function subnetAgeDays(
  registeredAtBlock: number | null | undefined,
  currentBlock: number | null | undefined,
): number | null {
  if (
    typeof registeredAtBlock !== "number" ||
    typeof currentBlock !== "number" ||
    !Number.isFinite(registeredAtBlock) ||
    !Number.isFinite(currentBlock)
  ) {
    return null;
  }
  const elapsed = currentBlock - registeredAtBlock;
  if (elapsed < 0) return null;
  return Math.floor((elapsed * FINNEY_BLOCK_SECONDS) / SECONDS_PER_DAY);
}

/** Round a positive value up to a "nice" axis maximum (1, 2, … ×10^n). 0/neg → 1. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

function healthColor(health: HealthState): string {
  return healthColorVar(
    health === "ok" ? "ok" : health === "warn" ? "warn" : health === "down" ? "down" : "unknown",
  );
}

export type BubblePoint = {
  netuid: number;
  name: string;
  x: number;
  y: number;
  r: number;
  color: string;
  age: number;
  participants: number;
  surfaces: number;
  health: HealthState;
};

/**
 * Project the filtered subnet rows onto the bubble scatter: x = age, y = verified
 * surfaces, radius = participants, colour = health — all on ONE shared domain so
 * the bubbles are comparable. Rows without a computable age or participant count
 * are dropped. Domains are clamped away from 0 (`Math.max(1, …)` / `|| 1`) so a
 * single row, or all-equal values, never divides by zero.
 */
export function buildBubbleLayout(rows: Subnet[]): {
  points: BubblePoint[];
  xMax: number;
  yMax: number;
} {
  const raw = rows
    .map((s) => {
      const age = subnetAgeDays(s.registered_at_block, s.block);
      const participants = typeof s.participants === "number" ? s.participants : null;
      if (age == null || participants == null) return null;
      return {
        netuid: s.netuid,
        name: s.name ?? `Subnet ${s.netuid}`,
        age,
        participants,
        surfaces: typeof s.surfaces_count === "number" ? s.surfaces_count : 0,
        health: (s.health ?? "unknown") as HealthState,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (raw.length === 0) return { points: [], xMax: 1, yMax: 1 };

  const xMax = niceMax(Math.max(1, ...raw.map((p) => p.age)));
  const yMax = niceMax(Math.max(1, ...raw.map((p) => p.surfaces)));
  const pMax = Math.max(1, ...raw.map((p) => p.participants));
  const innerW = BUBBLE_VB.w - BUBBLE_PAD.left - BUBBLE_PAD.right;
  const innerH = BUBBLE_VB.h - BUBBLE_PAD.top - BUBBLE_PAD.bottom;

  const points: BubblePoint[] = raw.map((p) => ({
    ...p,
    x: BUBBLE_PAD.left + (p.age / xMax) * innerW,
    y: BUBBLE_PAD.top + (1 - p.surfaces / yMax) * innerH,
    r: R_MIN + (p.participants / pMax) * (R_MAX - R_MIN),
    color: healthColor(p.health),
  }));

  return { points, xMax, yMax };
}
