import { isNoiseEvent } from "@/lib/metagraphed/chain-event-summary";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { formatPct } from "@/lib/metagraphed/format";

/**
 * The derivations behind /chain/blocks, /chain/extrinsics and /chain/events
 * (#11620). Pure, so the three pages can be one component and every rule
 * below is testable without a browser.
 */

/** Rows per page, and what the table menu offers. */
export const PAGE_SIZE = 50;
export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * The chain's target block time. Not read from a hyperparameter: the runtime
 * does not publish one, and /api/v1/blocks/summary's own `block_time.mean_ms`
 * has measured 12000 on every sample. It is the CENTRE of the tint scale, not
 * a threshold — a block is not late at 12001ms.
 */
export const TARGET_BLOCK_MS = 12_000;

export interface BlockRow extends Block {
  /** ms since the previous block, or null for the oldest row on the page. */
  block_time_ms: number | null;
}

/**
 * Blocks with the gap to their predecessor attached.
 *
 * The feed publishes no per-block time — only `observed_at` — so the gap is
 * the difference between consecutive rows. That makes it a property of the
 * PAIR, not of the row, and the oldest row on a page therefore has none: its
 * predecessor is on the next page and pretending otherwise would invent a
 * number. Rows arrive newest-first, so row i's predecessor is row i+1.
 *
 * A non-positive or absurd gap is dropped rather than shown. Two blocks can
 * share an `observed_at` when the poller catches up in one pass, and a gap
 * across a poller restart measures the outage, not the chain.
 */
export function blockRows(blocks: readonly Block[]): BlockRow[] {
  return blocks.map((block, i) => {
    const next = blocks[i + 1];
    const a = block.observed_at ? Date.parse(block.observed_at) : NaN;
    const b = next?.observed_at ? Date.parse(next.observed_at) : NaN;
    const gap = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
    return {
      ...block,
      block_time_ms: Number.isFinite(gap) && gap > 0 && gap <= 10 * TARGET_BLOCK_MS ? gap : null,
    };
  });
}

/**
 * A block time as a 0…1 tint: 0 at or under half the target, 1 at or over
 * double it, 0.5 exactly on target.
 *
 * Centred on the target rather than scaled across the page's own min/max,
 * because the reader's question is "is this block late", not "which of these
 * fifty was latest". A page of fifty perfectly on-time blocks must read as
 * fifty identical cells, which a page-relative scale would render as a
 * gradient over noise.
 */
export function cadenceTint(ms: number | null | undefined): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const ratio = ms / TARGET_BLOCK_MS;
  if (ratio <= 0.5) return 0;
  if (ratio >= 2) return 1;
  // 0.5x -> 0, 1x -> 0.5, 2x -> 1, linear in each half.
  return ratio <= 1 ? ratio - 0.5 : 0.5 + (ratio - 1) / 2;
}

/** `module.function`, or the half that exists, or null. */
export function callLabel(
  module: string | null | undefined,
  fn: string | null | undefined,
): string | null {
  const m = module?.trim() || null;
  const f = fn?.trim() || null;
  if (m && f) return `${m}.${f}`;
  return m ?? f;
}

/** `Pallet.Event`, the events feed's equivalent. */
export function eventLabel(event: Pick<ChainEvent, "pallet" | "method">): string | null {
  return callLabel(event.pallet, event.method);
}

/**
 * The distinct values of one field across the rows on screen, sorted.
 *
 * Built from the PAGE, not from a vocabulary endpoint, and the select says so:
 * none of /api/v1/blocks, /extrinsics or /chain-events publishes its own facet
 * counts, so any list offered here is "what is on this page" however it is
 * dressed up. A filter that silently offered fewer options than the chain has
 * would be worse than one that says where its options came from.
 */
export function pageFacet<Row>(
  rows: readonly Row[],
  of: (row: Row) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = of(row)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The offset pager's `total`, for a feed that publishes no count.
 *
 * /api/v1/blocks and /api/v1/extrinsics return newest-first pages and no
 * total, so the honest bound is everything read so far plus one more page
 * WHILE a full page says there may be one. A short page settles it exactly.
 * Reporting a larger guess would put a Next button in front of nothing.
 */
export function boundedTotal(offset: number, rowCount: number, limit: number): number {
  return offset + rowCount + (rowCount === limit ? limit : 0);
}

/** 1-based page number for an offset pager. */
export function pageOf(offset: number, limit: number): number {
  return limit > 0 ? Math.floor(offset / limit) + 1 : 1;
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The blocks hero: head, cadence, and how concentrated authorship is.
 *
 * The Nakamoto coefficient rather than an author count: "6,000 authors" and
 * "the smallest set that could halt the chain is 83" answer different
 * questions, and only the second is about decentralisation. It replaces the
 * author-share panel this page used to carry.
 */
export function blocksFacts(
  summary:
    | {
        block_time?: { mean_ms?: number; p90_ms?: number } | null;
        throughput?: { mean_extrinsics_per_block?: number } | null;
        author_concentration?: { nakamoto_coefficient?: number | null } | null;
        last_block?: number | null;
      }
    | null
    | undefined,
  head: number | null,
  fmt: { count: (n: number) => string; seconds: (s: number) => string },
): Fact[] {
  const facts: Fact[] = [];
  const at = head ?? summary?.last_block ?? null;
  if (at != null) facts.push({ key: "head", label: "Head block", value: `#${fmt.count(at)}` });
  const mean = summary?.block_time?.mean_ms;
  if (typeof mean === "number" && mean > 0) {
    facts.push({ key: "cadence", label: "Block time", value: fmt.seconds(mean / 1000) });
  }
  const perBlock = summary?.throughput?.mean_extrinsics_per_block;
  if (typeof perBlock === "number") {
    facts.push({
      key: "throughput",
      label: "Extrinsics per block",
      value: fmt.count(Math.round(perBlock * 10) / 10),
    });
  }
  const nakamoto = summary?.author_concentration?.nakamoto_coefficient;
  if (typeof nakamoto === "number") {
    facts.push({ key: "authors", label: "Nakamoto", value: fmt.count(nakamoto) });
  }
  return facts;
}

/**
 * The extrinsics hero, computed over the page on screen.
 *
 * Explicitly "on this page" rather than "in 24h": the feed is a cursor into
 * the newest extrinsics with no window parameter and no totals, so a 24-hour
 * claim would be a number this page cannot see. The share that succeeded is
 * counted over the rows that STATE a result — `success == null` means the tier
 * has no reading, which is not a failure, and folding those into the
 * denominator would report a success rate that falls as coverage falls.
 */
export function extrinsicsFacts(
  rows: readonly Extrinsic[],
  fmt: { count: (n: number) => string },
): Fact[] {
  const facts: Fact[] = [{ key: "rows", label: "On this page", value: fmt.count(rows.length) }];
  const stated = rows.filter((row) => row.success != null);
  if (stated.length > 0) {
    const ok = stated.filter((row) => row.success === true).length;
    facts.push({
      key: "ok",
      label: "Succeeded",
      value: `${formatPct(ok / stated.length, 1)}`,
    });
  }
  const top = topBy(rows, (row) => row.call_module);
  if (top) facts.push({ key: "module", label: "Top module", value: top.key });
  return facts;
}

/**
 * The events hero, from /api/v1/chain-events/stats over its own block window.
 *
 * The stats endpoint counts a real window (`blocks=N`) and the feed does not,
 * so the window is stated in the label rather than left to the reader.
 */
export function eventsFacts(
  stats:
    | {
        window_blocks?: number | null;
        groups?: number | null;
        activity?: readonly {
          pallet?: string | null;
          method?: string | null;
          count?: number | null;
        }[];
      }
    | null
    | undefined,
  fmt: { count: (n: number) => string },
): Fact[] {
  const activity = stats?.activity ?? [];
  if (activity.length === 0) return [];
  const total = activity.reduce((sum, row) => sum + (row.count ?? 0), 0);
  const blocks = stats?.window_blocks ?? null;
  const facts: Fact[] = [
    {
      key: "events",
      label: blocks ? `events in ${fmt.count(blocks)} blocks` : "events",
      value: fmt.count(total),
    },
  ];
  const top = [...activity].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  const label = top ? callLabel(top.pallet, top.method) : null;
  if (label) facts.push({ key: "top", label: "Most frequent", value: label });
  if (stats?.groups != null) {
    facts.push({ key: "kinds", label: "Distinct kinds", value: fmt.count(stats.groups) });
  }
  return facts;
}

/** The most common non-empty value of `of`, with its count. */
export function topBy<Row>(
  rows: readonly Row[],
  of: (row: Row) => string | null | undefined,
): { key: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = of(row)?.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of counts) {
    // Ties break on the name so the fact does not flicker between two equally
    // common modules as rows refresh.
    if (!best || count > best.count || (count === best.count && key < best.key)) {
      best = { key, count };
    }
  }
  return best;
}

/**
 * The events feed with its plumbing hidden, and how many that was.
 *
 * #8253 measured `System.ExtrinsicSuccess`, `System.ExtrinsicFailed` and
 * `TransactionPayment.TransactionFeePaid` at 68% of the unfiltered feed: three
 * event kinds emitted once per extrinsic that say nothing a reader of an event
 * stream came for. They are hidden by default and the URL keeps a way back,
 * because a firehose nobody can turn off is not a feature.
 *
 * The count comes back with the rows rather than being recomputed by the
 * caller: "we hid 34" and "there are none" are different answers, and a page
 * that shows an empty table without saying which one it means is lying by
 * omission.
 */
export function withoutNoise(
  events: readonly ChainEvent[],
  include: boolean,
): { rows: ChainEvent[]; hidden: number } {
  if (include) return { rows: [...events], hidden: 0 };
  const rows = events.filter((event) => !isNoiseEvent(event.pallet, event.method));
  return { rows, hidden: events.length - rows.length };
}
