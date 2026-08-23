/**
 * The derivations behind /subnets/$netuid (#11612).
 *
 * Every function here is pure and takes only API shapes, so the seven
 * sections stay declarative and the arithmetic that decides what a reader
 * sees -- a rank, a delta, a residual -- is testable without a DOM.
 */
import type {
  EmissionSplitPoint,
  MetagraphNeuron,
  SubnetEconomics,
  SubnetHistoryPoint,
  SubnetOhlcCandle,
  Surface,
} from "@/lib/metagraphed/types";

export type Window = "7d" | "30d" | "90d";

export const WINDOW_OPTIONS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

export function windowDays(window: Window): number {
  return window === "7d" ? 7 : window === "30d" ? 30 : 90;
}

/**
 * The subnet's position in the emission ranking, 1-based.
 *
 * Ranked over EVERY row the economics list carries, not over the rows that
 * happen to declare a share: a subnet earning nothing is still ranked last,
 * and dropping it would silently promote everyone below it.
 */
export function emissionRank(rows: readonly SubnetEconomics[], netuid: number): number | null {
  if (rows.length === 0) return null;
  const share = (row: SubnetEconomics) =>
    typeof row.emission_share === "number" && Number.isFinite(row.emission_share)
      ? row.emission_share
      : -1;
  const mine = rows.find((row) => row.netuid === netuid);
  if (!mine) return null;
  const ahead = rows.filter((row) => share(row) > share(mine)).length;
  return ahead + 1;
}

/** Fractional change between the first and last finite value, or null. */
export function changeOver(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const first = finite[0];
  const last = finite[finite.length - 1];
  if (first === undefined || last === undefined || first === 0) return null;
  return (last - first) / first;
}

/** A signed percentage for a `FactCell` delta, with the tone the sign implies. */
export function deltaCell(
  change: number | null,
  better: "high" | "low" = "high",
): { text: string; tone: "good" | "bad" | "neutral" } | undefined {
  if (change === null || !Number.isFinite(change)) return undefined;
  const pct = change * 100;
  const text = `${pct >= 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
  if (Math.abs(pct) < 0.05) return { text: "0%", tone: "neutral" };
  const good = better === "high" ? pct > 0 : pct < 0;
  return { text, tone: good ? "good" : "bad" };
}

/**
 * OHLC candles → chronological close-price points, newest-last.
 *
 * The API serves candles newest-FIRST; a line drawn in that order runs
 * backwards through time and every delta reads with its sign flipped.
 */
export function closePoints(
  candles: readonly Partial<Pick<SubnetOhlcCandle, "bucket_start" | "close">>[],
  days: number,
): { t: number; v: number }[] {
  const points = candles
    .filter(
      (c) =>
        typeof c.bucket_start === "number" &&
        typeof c.close === "number" &&
        Number.isFinite(c.close),
    )
    .map((c) => ({ t: c.bucket_start as number, v: c.close as number }))
    .sort((a, b) => a.t - b.t);
  return points.slice(-days);
}

/** The trailing `days` history points, oldest-first. */
export function trailing<T extends { snapshot_date: string }>(
  points: readonly T[],
  days: number,
): T[] {
  return [...points].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)).slice(-days);
}

/** Traded volume in TAO over the window. */
export function volumeOver(
  candles: readonly Partial<Pick<SubnetOhlcCandle, "bucket_start" | "volume_tao">>[],
  days: number,
): number | null {
  const recent = [...candles]
    .filter((c) => typeof c.bucket_start === "number")
    .sort((a, b) => (a.bucket_start as number) - (b.bucket_start as number))
    .slice(-days);
  const sum = recent.reduce(
    (acc, c) => acc + (typeof c.volume_tao === "number" ? c.volume_tao : 0),
    0,
  );
  return recent.length > 0 ? sum : null;
}

export const EMISSION_SERIES = ["owner", "validators", "miners", "burned"] as const;

export interface EmissionColumn {
  key: string;
  label: string;
  axisLabel: string;
  total: number;
  segments: { key: string; label: string; value: number }[];
}

/**
 * Per-day emission by recipient class, in alpha.
 *
 * Days where nothing was measured are dropped rather than drawn as an empty
 * column -- an all-zero column in a stacked chart reads as "the subnet paid
 * nobody", which is a different claim from "we have no reading".
 */
export function emissionColumns(points: readonly EmissionSplitPoint[]): EmissionColumn[] {
  const columns: EmissionColumn[] = [];
  for (const point of points) {
    const parts = [
      { key: "owner", label: "Owner", value: point.owner_alpha },
      { key: "validators", label: "Validators", value: point.validator_alpha },
      { key: "miners", label: "Miners", value: point.miner_alpha },
      { key: "burned", label: "Burned", value: point.burned_alpha },
    ].map((p) => ({
      key: p.key,
      label: p.label,
      value: typeof p.value === "number" && Number.isFinite(p.value) ? p.value : 0,
    }));
    const total = parts.reduce((acc, p) => acc + p.value, 0);
    if (total <= 0) continue;
    const day = point.snapshot_date;
    columns.push({
      key: day,
      label: day,
      axisLabel: day.slice(5),
      total,
      segments: parts,
    });
  }
  return columns;
}

/** Totals per recipient class over the whole series, for the legend. */
export function emissionTotals(columns: readonly EmissionColumn[]): {
  key: string;
  label: string;
  value: number;
  share: number;
}[] {
  const totals = new Map<string, { label: string; value: number }>();
  let grand = 0;
  for (const column of columns) {
    for (const segment of column.segments) {
      const entry = totals.get(segment.key) ?? { label: segment.label, value: 0 };
      entry.value += segment.value;
      totals.set(segment.key, entry);
      grand += segment.value;
    }
  }
  return [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      value: entry.value,
      share: grand > 0 ? entry.value / grand : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

/** The validator with the most stake — the hero's delegate target. */
export function topValidator(validators: readonly MetagraphNeuron[]): MetagraphNeuron | null {
  let best: MetagraphNeuron | null = null;
  for (const v of validators) {
    const stake = typeof v.stake_tao === "number" ? v.stake_tao : 0;
    const bestStake = best && typeof best.stake_tao === "number" ? best.stake_tao : -1;
    if (stake > bestStake) best = v;
  }
  return best;
}

/** Per-surface uptime as a percentage, keyed by surface id. */
export function uptimeBySurface(
  surfaces: readonly { surface_id?: string; uptime_ratio?: number | null }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of surfaces) {
    if (!row.surface_id) continue;
    if (typeof row.uptime_ratio !== "number" || !Number.isFinite(row.uptime_ratio)) continue;
    map.set(row.surface_id, row.uptime_ratio * 100);
  }
  return map;
}

/**
 * Probed surfaces, most-reliable last so the rail reads as a ranking.
 *
 * A surface with no probe reading keeps its row with a null value -- the rail
 * draws no marker for it, which is the honest rendering of "never measured"
 * and is not the same picture as 0%.
 */
export function surfaceRail(
  surfaces: readonly Surface[],
  uptime: Map<string, number>,
  subnetName?: string,
): { key: string; label: string; value: number | null; tag?: string; href?: string }[] {
  return surfaces
    .filter((s) => s.public_safe !== false && Boolean(s.url))
    .map((s) => ({
      key: s.id ?? s.url ?? s.name ?? "",
      label: withoutSubnetPrefix(s.name ?? s.kind ?? s.url ?? "surface", subnetName),
      value: s.id ? (uptime.get(s.id) ?? null) : null,
      tag: s.kind,
      href: s.url,
    }))
    .filter((row) => row.key !== "")
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

/**
 * Drops the subnet's own name from the front of a surface name.
 *
 * Every surface a subnet registers tends to be titled "<Subnet> <thing>", and
 * the rail already says which subnet you are on -- so the prefix costs the
 * characters that carry the distinction. Only stripped when something is left
 * behind: "blockmachine" alone stays "blockmachine".
 */
export function withoutSubnetPrefix(label: string, subnetName?: string): string {
  if (!subnetName) return label;
  const prefix = subnetName.trim().toLowerCase();
  if (prefix.length === 0 || !label.toLowerCase().startsWith(prefix)) return label;
  const rest = label.slice(prefix.length).replace(/^[\s:-]+/, "");
  return rest.length > 0 ? rest : label;
}

/** Peer subnets in the same domain, by emission share, richest first. */
export function domainPeers(
  rows: readonly SubnetEconomics[],
  netuids: readonly number[],
  limit = 10,
): SubnetEconomics[] {
  const wanted = new Set(netuids);
  return rows
    .filter((row) => wanted.has(row.netuid))
    .sort((a, b) => (b.emission_share ?? 0) - (a.emission_share ?? 0))
    .slice(0, limit);
}

/**
 * Peers for a subnet with no domain: the rows immediately either side of it
 * in the emission ranking. A subnet the registry has not classified still has
 * comparable subnets -- the ones it is competing with for emission.
 */
export function emissionNeighbours(
  rows: readonly SubnetEconomics[],
  netuid: number,
  span = 10,
): SubnetEconomics[] {
  const ranked = [...rows].sort((a, b) => (b.emission_share ?? 0) - (a.emission_share ?? 0));
  const index = ranked.findIndex((row) => row.netuid === netuid);
  if (index < 0) return ranked.slice(0, span);
  const half = Math.floor(span / 2);
  const start = Math.max(0, Math.min(index - half, ranked.length - span));
  return ranked.slice(start, start + span);
}

export interface ActivityKind {
  key: string;
  label: string;
  value: number;
  detail: { key: string; label: string; value: string }[];
}

/**
 * Event kinds as rail rows, busiest first.
 *
 * A kind that fired zero times in the window is dropped rather than railed at
 * zero: an empty rail row claims the kind is possible here and idle, which is
 * a stronger statement than "it did not appear".
 */
export function activityKindRail(
  kinds: readonly {
    event_kind?: string;
    category?: string;
    event_count?: number;
    hotkey_count?: number;
    coldkey_count?: number;
  }[],
): ActivityKind[] {
  return kinds
    .filter((kind) => Boolean(kind.event_kind) && (kind.event_count ?? 0) > 0)
    .map((kind) => ({
      key: kind.event_kind!,
      label: kind.event_kind!,
      value: kind.event_count!,
      detail: [
        { key: "category", label: "Category", value: kind.category ?? "other" },
        { key: "hotkeys", label: "Hotkeys", value: String(kind.hotkey_count ?? 0) },
        { key: "coldkeys", label: "Coldkeys", value: String(kind.coldkey_count ?? 0) },
      ],
    }))
    .sort((a, b) => b.value - a.value);
}

/** Category totals and their share of the window, busiest first. */
export function categoryTotals(
  categories: readonly { category?: string; event_count?: number }[],
): { key: string; label: string; value: number; share: number }[] {
  const rows = categories
    .filter((row) => Boolean(row.category) && (row.event_count ?? 0) > 0)
    .map((row) => ({ key: row.category!, label: row.category!, value: row.event_count! }));
  const grand = rows.reduce((acc, row) => acc + row.value, 0);
  return rows
    .map((row) => ({ ...row, share: grand > 0 ? row.value / grand : 0 }))
    .sort((a, b) => b.value - a.value);
}

/** History points → the value series a momentum delta is computed from. */
export function seriesOf(
  points: readonly SubnetHistoryPoint[],
  pick: (point: SubnetHistoryPoint) => number | null | undefined,
): (number | null | undefined)[] {
  return points.map(pick);
}
