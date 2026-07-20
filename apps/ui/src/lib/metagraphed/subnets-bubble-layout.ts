// #6884: layout math for the /subnets "bubble" view — a cryptobubbles-style
// PACKED map (not an axis scatter): one bubble per subnet, area ∝ emission share
// (the network-weight "market cap" analog, already joined onto the list rows),
// colour = health, labelled with the symbol + emission % so it reads at a glance.
// Kept pure + node-testable (no React/SVG) so the sizing / packing / formatting
// math is unit-tested. A deterministic spiral pack (biggest in the middle) keeps
// it server-renderable — no client physics, unlike the real cryptobubbles.
import { healthColorVar } from "@/lib/health-tokens";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

const R_MIN = 16; // px in viewBox units — floor so a label still fits-ish
const R_MAX = 90;
const GAP = 3; // padding between packed bubbles

export type PackedBubble = {
  netuid: number;
  name: string;
  symbol: string;
  emissionShare: number; // 0..1 fraction of network emission
  health: HealthState;
  color: string;
  r: number;
  x: number;
  y: number;
};

export type BubblePack = {
  bubbles: PackedBubble[];
  width: number;
  height: number;
};

/** Area-proportional radius: r ∝ sqrt(share), so a 4× emission reads as 4× area. */
export function bubbleRadius(share: number, maxShare: number): number {
  if (!Number.isFinite(share) || share <= 0 || maxShare <= 0) return R_MIN;
  const scaled = Math.sqrt(share / maxShare); // 0..1
  return R_MIN + scaled * (R_MAX - R_MIN);
}

/** Compact emission-share label, e.g. 0.0541 -> "5.41%", 0 -> "0%". */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const pct = share * 100;
  return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;
}

// Place a bubble of radius r at the first point on an outward spiral from the
// centre that doesn't overlap an already-placed bubble. Deterministic (no RNG),
// so it renders identically on server + client.
function placeOnSpiral(
  r: number,
  placed: Array<{ x: number; y: number; r: number }>,
): { x: number; y: number } {
  if (placed.length === 0) return { x: 0, y: 0 };
  const step = 6;
  for (let t = 0; t < 20000; t += 1) {
    const angle = t * 0.5;
    const dist = step * Math.sqrt(t);
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist;
    let ok = true;
    for (const p of placed) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (Math.hypot(dx, dy) < r + p.r + GAP) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y };
  }
  return { x: 0, y: 0 };
}

/**
 * Pack the filtered subnet rows into a bubble map. Rows are sized by emission
 * share (area-proportional), coloured by health, sorted biggest-first so the
 * heaviest subnets land in the centre. Returns bubbles in a 0-origin coordinate
 * space plus the overall width/height so the caller can centre a viewBox on it.
 */
export function packBubbles(rows: Subnet[]): BubblePack {
  const items = rows.map((s) => ({
    netuid: s.netuid,
    name: s.name ?? `Subnet ${s.netuid}`,
    symbol: (typeof s.symbol === "string" && s.symbol) || `#${s.netuid}`,
    emissionShare:
      typeof s.emission_share === "number" && s.emission_share > 0 ? s.emission_share : 0,
    health: (s.health ?? "unknown") as HealthState,
  }));
  if (items.length === 0) return { bubbles: [], width: 0, height: 0 };

  const maxShare = Math.max(...items.map((i) => i.emissionShare), 0);
  const sized = items
    .map((i) => ({
      ...i,
      r: bubbleRadius(i.emissionShare, maxShare),
      color: healthColorVar(i.health),
    }))
    .sort((a, b) => b.r - a.r);

  const placed: Array<{ x: number; y: number; r: number }> = [];
  const bubbles: PackedBubble[] = sized.map((b) => {
    const { x, y } = placeOnSpiral(b.r, placed);
    placed.push({ x, y, r: b.r });
    return { ...b, x, y };
  });

  // Normalise to a 0-origin box with a small margin so nothing clips the edge.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bubbles) {
    minX = Math.min(minX, b.x - b.r);
    minY = Math.min(minY, b.y - b.r);
    maxX = Math.max(maxX, b.x + b.r);
    maxY = Math.max(maxY, b.y + b.r);
  }
  const margin = 8;
  for (const b of bubbles) {
    b.x = b.x - minX + margin;
    b.y = b.y - minY + margin;
  }
  return {
    bubbles,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}
