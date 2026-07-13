import { classNames } from "@/lib/format";

export interface TreemapMiniDatum {
  label: string;
  value: number;
  color?: string;
}

interface LaidOutTile extends TreemapMiniDatum {
  /** Position + size as percentages of the map box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of the total value, 0–1. */
  share: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// Inline text is only drawn on tiles big enough to hold it without overlapping
// or truncating — width/height are percentages of the map box. In a skewed
// distribution (one dominant validator, several tiny tail tiles) the tail tiles
// squash to near-zero, so an always-drawn label stacked its value on top of
// itself into illegible text (#3937). Instead: below the label threshold a tile
// draws no inline text at all (its full label/value/share stay available via the
// native `title` tooltip); the value only appears once the tile is tall enough
// to fit a second line under the label. Thresholds are tuned for the smallest
// (mobile) map size, so a tile legible there is legible at every larger width.
const MIN_TILE_W_FOR_LABEL = 16;
const MIN_TILE_H_FOR_LABEL = 12;
const MIN_TILE_W_FOR_VALUE = 16;
const MIN_TILE_H_FOR_VALUE = 22;

/** Worst (largest) aspect ratio in a row laid along `side`. */
function worstRatio(areas: number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Infinity;
  const s = sum(areas);
  if (s <= 0) return Infinity;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = s * s;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) over a 100×100 box, so
 * each tile's area is proportional to its value. Pure + dependency-free; returns
 * tiles positioned in percentage units ready for absolute CSS placement.
 */
function squarify(data: TreemapMiniDatum[]): LaidOutTile[] {
  const positive = data.filter((d) => d.value > 0);
  const total = sum(positive.map((d) => d.value));
  if (total <= 0) return [];

  // Areas normalized so they sum to the box area (100 × 100 = 10_000).
  const items = positive
    .map((d) => ({
      datum: d,
      area: (d.value / total) * 10_000,
      share: d.value / total,
    }))
    .sort((a, b) => b.area - a.area);

  const tiles: LaidOutTile[] = [];
  let rect: Rect = { x: 0, y: 0, w: 100, h: 100 };
  let row: typeof items = [];

  const layoutRow = (rowItems: typeof items, r: Rect): Rect => {
    const rowArea = sum(rowItems.map((i) => i.area));
    if (rowArea <= 0) return r;
    if (r.w >= r.h) {
      // Stack the row as a column on the left edge.
      const dw = rowArea / r.h;
      let y = r.y;
      for (const it of rowItems) {
        const h = it.area / dw;
        tiles.push({ ...it.datum, share: it.share, x: r.x, y, w: dw, h });
        y += h;
      }
      return { x: r.x + dw, y: r.y, w: r.w - dw, h: r.h };
    }
    // Stack the row along the top edge.
    const dh = rowArea / r.w;
    let x = r.x;
    for (const it of rowItems) {
      const w = it.area / dh;
      tiles.push({ ...it.datum, share: it.share, x, y: r.y, w, h: dh });
      x += w;
    }
    return { x: r.x, y: r.y + dh, w: r.w, h: r.h - dh };
  };

  for (const item of items) {
    const side = Math.min(rect.w, rect.h);
    const current = row.map((i) => i.area);
    const withItem = [...current, item.area];
    if (
      row.length === 0 ||
      worstRatio(withItem, side) <= worstRatio(current, side)
    ) {
      row.push(item);
    } else {
      rect = layoutRow(row, rect);
      row = [item];
    }
  }
  if (row.length > 0) layoutRow(row, rect);

  return tiles;
}

interface Props {
  data: TreemapMiniDatum[];
  className?: string;
  /** Formats the value shown on each tile + in its title. Defaults to `String`. */
  formatValue?: (value: number) => string;
  /** Accessible name for the whole map. */
  ariaLabel?: string;
}

/**
 * Tiny squarified treemap, no dependencies. Each tile's area is proportional to
 * its value — a dominance/concentration view that complements a ranked bar list
 * (e.g. validator stake share within a subnet).
 */
export function TreemapMini({
  data,
  className,
  formatValue = String,
  ariaLabel,
}: Props) {
  const tiles = squarify(data);
  if (tiles.length === 0) return null;

  const label =
    ariaLabel ??
    `Treemap of ${tiles.length} items sized by share: ` +
      tiles.map((t) => `${t.label} ${(t.share * 100).toFixed(1)}%`).join(", ");

  return (
    <div
      role="img"
      aria-label={label}
      className={classNames(
        "relative aspect-[16/9] w-full overflow-hidden rounded-md",
        className,
      )}
    >
      {tiles.map((t) => (
        <div
          key={t.label}
          title={`${t.label} · ${formatValue(t.value)} · ${(t.share * 100).toFixed(1)}%`}
          className="absolute overflow-hidden p-1"
          style={{
            left: `${t.x}%`,
            top: `${t.y}%`,
            width: `${t.w}%`,
            height: `${t.h}%`,
          }}
        >
          <div
            className="flex h-full w-full flex-col justify-between rounded-sm border border-background/40 p-1.5"
            style={{ background: t.color ?? "var(--accent)" }}
          >
            {t.w > MIN_TILE_W_FOR_LABEL && t.h > MIN_TILE_H_FOR_LABEL ? (
              <>
                <span className="truncate font-mono text-[10px] font-medium leading-none text-accent-foreground">
                  {t.label}
                </span>
                {t.w > MIN_TILE_W_FOR_VALUE && t.h > MIN_TILE_H_FOR_VALUE ? (
                  <span className="truncate font-mono text-[9px] leading-none text-accent-foreground/80">
                    {formatValue(t.value)}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
