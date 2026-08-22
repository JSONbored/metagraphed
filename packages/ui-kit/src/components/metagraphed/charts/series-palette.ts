/**
 * Stable categorical colours for chart series (#11608).
 *
 * A series keeps its swatch for as long as the page lives, no matter how the
 * data re-orders between refetches or which chart draws it: the first time a
 * key is seen it takes the next free ramp index, and that assignment is kept
 * in a page-level registry (the `ActiveEntityProvider` tree owns one). Keys
 * beyond the ten assignable swatches collapse into `Other`, which takes the
 * eleventh ramp colour -- the reference draws Other in a ramp colour, not
 * grey, so it still reads as a share of the column.
 */
export const CHART_RAMP_SIZE = 10;
export const OTHER_COLOR = "var(--chart-11)";
export const OTHER_KEY = "Other";

export interface SeriesPalette {
  /** `--chart-1` … `--chart-10`, or `--chart-11` for a collapsed series. */
  colorOf: (key: string) => string;
  /** 1-based ramp index, or null for a collapsed series. */
  indexOf: (key: string) => number | null;
  /** Whether the key collapsed into `Other`. */
  isOther: (key: string) => boolean;
}

export class SeriesPaletteRegistry {
  private readonly slots = new Map<string, number>();

  /** Assigns the next free ramp index to every unseen key, in the order given. */
  assign(keys: readonly string[]): void {
    for (const key of keys) {
      if (key === OTHER_KEY || this.slots.has(key)) continue;
      if (this.slots.size >= CHART_RAMP_SIZE) continue;
      this.slots.set(key, this.slots.size + 1);
    }
  }

  indexOf(key: string): number | null {
    return this.slots.get(key) ?? null;
  }

  palette(): SeriesPalette {
    const indexOf = (key: string) => this.indexOf(key);
    return {
      indexOf,
      isOther: (key) => key === OTHER_KEY || indexOf(key) === null,
      colorOf: (key) => {
        const i = indexOf(key);
        return i === null ? OTHER_COLOR : `var(--chart-${i})`;
      },
    };
  }

  /** The keys that own a swatch, in ramp order. */
  keys(): string[] {
    return [...this.slots.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
  }
}

/**
 * Collapses series past the ramp into one `Other` series per column so a
 * stacked chart never needs a twelfth colour. `seriesOrder` decides who keeps
 * a swatch: the first ten keys in that order.
 */
export function collapseOther<T extends { key: string; value: number }>(
  segments: readonly T[],
  registry: SeriesPaletteRegistry,
  label = OTHER_KEY,
): Array<{ key: string; label: string; value: number }> {
  const kept: Array<{ key: string; label: string; value: number }> = [];
  let other = 0;
  for (const s of segments) {
    if (registry.indexOf(s.key) === null) other += s.value;
    else
      kept.push({
        key: s.key,
        label: (s as { label?: string }).label ?? s.key,
        value: s.value,
      });
  }
  if (other > 0) kept.push({ key: OTHER_KEY, label, value: other });
  return kept;
}
