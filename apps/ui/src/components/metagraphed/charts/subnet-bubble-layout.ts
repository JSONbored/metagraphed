// Pure layout math for the /subnets bubble view (#6884). Kept dependency-free
// and separate from the React component so the scaling/positioning invariants
// can be unit-tested directly (same split as validator-dominance-ranking.ts).

export interface BubbleInput {
  netuid: number;
  name?: string;
  /** Raw horizontal metric (subnet age, days). */
  x: number;
  /** Raw vertical metric (manifested surface count). */
  y: number;
  /** Raw size metric (participant count). */
  size: number;
  /** Health state key: ok | warn | down | unknown. */
  health: string;
}

export interface BubbleNode extends BubbleInput {
  /** Horizontal center, 0–100 as a percent of the plot box (left). */
  cx: number;
  /** Vertical center, 0–100 as a percent of the plot box (top). Already
   *  flipped so a higher `y` sits nearer the top. */
  cy: number;
  /** Radius in px (area-proportional to `size`). */
  r: number;
}

export interface Domain {
  min: number;
  max: number;
}

/** Min/max over the finite numbers in `values`, defaulting to {0,0} when empty. */
export function bubbleDomain(values: number[]): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * Map `v` from `domain` onto [outMin, outMax]. A zero-width domain (every value
 * equal, or a single point) maps to the midpoint so the bubble lands centered
 * rather than pinned to an edge or dividing by zero.
 */
export function scaleLinear(v: number, domain: Domain, outMin: number, outMax: number): number {
  const span = domain.max - domain.min;
  if (span <= 0) return (outMin + outMax) / 2;
  const t = (v - domain.min) / span;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return outMin + clamped * (outMax - outMin);
}

/**
 * Radius in px for a size metric, scaled by AREA (sqrt of the value) so the
 * visual weight of a bubble tracks the metric honestly — the standard bubble
 * encoding. A zero-width size domain renders every bubble at the min radius.
 */
export function bubbleRadius(size: number, domain: Domain, minR: number, maxR: number): number {
  const span = domain.max - domain.min;
  const s = typeof size === "number" && Number.isFinite(size) ? size : domain.min;
  if (span <= 0) return minR;
  const t = (s - domain.min) / span;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return minR + Math.sqrt(clamped) * (maxR - minR);
}

export interface LayoutOptions {
  minR: number;
  maxR: number;
}

/**
 * Lay out bubbles inside a 0–100 percentage box. Callers place the box with CSS
 * (padding for axis labels), so the percentages are resolution-independent and
 * never overflow horizontally. Larger, denser bubbles are drawn first so small
 * outliers stay clickable on top — the whole point of the view.
 */
export function layoutBubbles(data: BubbleInput[], opts: LayoutOptions): BubbleNode[] {
  const xDomain = bubbleDomain(data.map((d) => d.x));
  const yDomain = bubbleDomain(data.map((d) => d.y));
  const sizeDomain = bubbleDomain(data.map((d) => d.size));
  return data
    .map((d) => ({
      ...d,
      cx: scaleLinear(d.x, xDomain, 0, 100),
      cy: 100 - scaleLinear(d.y, yDomain, 0, 100),
      r: bubbleRadius(d.size, sizeDomain, opts.minR, opts.maxR),
    }))
    .sort((a, b) => b.r - a.r);
}
