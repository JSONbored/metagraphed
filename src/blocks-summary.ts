// Block-production summary: aggregate health of recent finalized blocks from the
// `blocks` D1 tier — how fast blocks are produced (inter-block time distribution),
// how much they carry (extrinsic/event throughput), how DECENTRALIZED production is
// (concentration of block authorship across authors — the novel measurement, the
// block-producer analog of the stake/emission concentration scorecards), and the
// runtime spec-version spread. Pure shaping (buildBlocksSummary) + a thin D1 loader
// (loadBlocksSummary); the Worker adds the REST envelope + edge cache. Null-safe: a
// cold/absent store yields a schema-stable zeroed card (never throws).
//
// Distinct from /api/v1/chain/signers (who SIGNS extrinsics) — this is who AUTHORS
// blocks, a base-layer validator-set decentralization signal, not a tx-fee signal.

import { computeConcentration } from "./concentration.mjs";

// The `blocks` columns the summary reads. `author` is best-effort/nullable; the
// counts are nullable INTEGERs; `observed_at` is the block timestamp (epoch ms).
export const BLOCKS_SUMMARY_READ_COLUMNS =
  "block_number, author, extrinsic_count, event_count, spec_version, observed_at";

// Bound the scan so the summary reads a fixed recent window rather than the whole
// chain history — newest-first, then shaped in ascending order for the block-time
// diffs. ~5000 blocks ≈ the last ~16h at 12s/block.
export const BLOCKS_SUMMARY_SCAN_CAP = 5000;

const THROUGHPUT_UNAVAILABLE = null;
const BLOCK_TIME_PERCENTILES = [50, 90];

// Round a duration/mean to whole milliseconds — inter-block time has no meaningful
// sub-ms precision, and integer ms keeps the JSON clean.
function roundMs(value: number): number {
  return Math.round(value);
}

// Round a per-block mean (extrinsics/events) to 2 dp.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Strict non-negative integer coercion for identity/timestamp cells: accept ONLY a
// real number or an all-digits string, so a blank/null/false cell is rejected
// rather than coerced to 0 (Number("") === Number(null) === Number(false) === 0).
function toInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function toTimestamp(value: unknown): number | null {
  const ms = toInt(value);
  if (ms == null) return null;
  return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

// A nullable count cell (extrinsic_count / event_count) coerced to a finite,
// non-negative integer, defaulting to 0 — a block with an absent count carried 0
// of that thing, which must not poison the totals or the mean.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

// Nearest-rank percentile over a non-empty ascending array (rank = ceil(p/100 · n),
// 1-based). Only called after the caller establishes the array is non-empty.
function percentile(ascending: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[rank - 1];
}

interface BlockTimeDistribution {
  count: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
  [key: `p${number}_ms`]: number;
}

// Distribution summary of the inter-block intervals (ms): count/mean/min/max plus
// the p50/p90 spread, or null when fewer than two consecutive blocks are present
// (no interval to measure).
function blockTimeDistribution(
  intervals: number[],
): BlockTimeDistribution | null {
  const count = intervals.length;
  if (count === 0) return null;
  const ascending = [...intervals].sort((a, b) => a - b);
  const total = ascending.reduce((sum, ms) => sum + ms, 0);
  const summary: BlockTimeDistribution = {
    count,
    mean_ms: roundMs(total / count),
    min_ms: roundMs(ascending[0]),
    max_ms: roundMs(ascending[count - 1]),
  };
  for (const p of BLOCK_TIME_PERCENTILES) {
    summary[`p${p}_ms`] = roundMs(percentile(ascending, p));
  }
  return summary;
}

interface ParsedBlock {
  block_number: number;
  observed_at: number | null;
  author: string | null;
  extrinsic_count: number;
  event_count: number;
  spec_version: number | null;
}

export interface BlocksSummaryResult {
  schema_version: 1;
  block_count: number;
  first_block: number | null;
  last_block: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  block_time: BlockTimeDistribution | null;
  throughput: {
    total_extrinsics: number;
    total_events: number;
    mean_extrinsics_per_block: number;
    mean_events_per_block: number;
    max_extrinsics_in_block: number;
  } | null;
  distinct_authors: number;
  author_concentration: unknown;
  distinct_spec_versions: number;
  latest_spec_version: number | null;
}

// Shape the recent `blocks` rows into the production summary. `rows` may arrive in
// any order (the loader reads newest-first); they are sorted ascending by
// block_number here so the inter-block time diffs are correct. Null-safe on
// junk/sparse rows — an empty array yields a schema-stable zeroed card.
export function buildBlocksSummary(
  rows: Array<Record<string, unknown>> | null | undefined,
): BlocksSummaryResult {
  const list = Array.isArray(rows) ? rows : [];
  const blocks: ParsedBlock[] = [];
  for (const row of list) {
    const blockNumber = toInt(row?.block_number);
    if (blockNumber == null) continue;
    blocks.push({
      block_number: blockNumber,
      observed_at: toTimestamp(row?.observed_at),
      author: typeof row?.author === "string" && row.author ? row.author : null,
      extrinsic_count: toCount(row?.extrinsic_count),
      event_count: toCount(row?.event_count),
      spec_version: toInt(row?.spec_version),
    });
  }
  blocks.sort((a, b) => a.block_number - b.block_number);

  const blockCount = blocks.length;
  if (blockCount === 0) {
    return {
      schema_version: 1,
      block_count: 0,
      first_block: null,
      last_block: null,
      first_observed_at: null,
      last_observed_at: null,
      block_time: null,
      throughput: THROUGHPUT_UNAVAILABLE,
      distinct_authors: 0,
      author_concentration: null,
      distinct_spec_versions: 0,
      latest_spec_version: null,
    };
  }

  // Inter-block intervals: only between genuinely CONSECUTIVE blocks (block_number
  // gap of exactly 1) with a positive elapsed time, so a pruned gap or a clock
  // regression never fabricates an interval.
  const intervals: number[] = [];
  for (let i = 1; i < blocks.length; i += 1) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    if (
      cur.block_number - prev.block_number === 1 &&
      prev.observed_at != null &&
      cur.observed_at != null &&
      cur.observed_at > prev.observed_at
    ) {
      intervals.push(cur.observed_at - prev.observed_at);
    }
  }

  // Throughput: totals + per-block means/max over the window.
  let totalExtrinsics = 0;
  let totalEvents = 0;
  let maxExtrinsics = 0;
  const authorBlocks = new Map<string, number>();
  const specVersions = new Set<number>();
  for (const block of blocks) {
    totalExtrinsics += block.extrinsic_count;
    totalEvents += block.event_count;
    if (block.extrinsic_count > maxExtrinsics)
      maxExtrinsics = block.extrinsic_count;
    if (block.author != null) {
      authorBlocks.set(block.author, (authorBlocks.get(block.author) ?? 0) + 1);
    }
    if (block.spec_version != null) specVersions.add(block.spec_version);
  }

  const observedStamps = blocks
    .map((block) => block.observed_at)
    .filter((ms): ms is number => ms != null);
  const firstObserved = observedStamps.length
    ? Math.min(...observedStamps)
    : null;
  const lastObserved = observedStamps.length
    ? Math.max(...observedStamps)
    : null;

  return {
    schema_version: 1,
    block_count: blockCount,
    first_block: blocks[0].block_number,
    last_block: blocks[blockCount - 1].block_number,
    first_observed_at:
      firstObserved == null ? null : new Date(firstObserved).toISOString(),
    last_observed_at:
      lastObserved == null ? null : new Date(lastObserved).toISOString(),
    block_time: blockTimeDistribution(intervals),
    throughput: {
      total_extrinsics: totalExtrinsics,
      total_events: totalEvents,
      mean_extrinsics_per_block: round2(totalExtrinsics / blockCount),
      mean_events_per_block: round2(totalEvents / blockCount),
      max_extrinsics_in_block: maxExtrinsics,
    },
    // Block-authorship decentralization: how concentrated block production is
    // across the authors in the window (Gini/HHI/Nakamoto/top-share/entropy over
    // each author's block count). Null when no block carried an author.
    distinct_authors: authorBlocks.size,
    author_concentration: computeConcentration([...authorBlocks.values()]),
    distinct_spec_versions: specVersions.size,
    // The runtime version at the newest block in the window.
    latest_spec_version: blocks[blockCount - 1].spec_version,
  };
}

// Shared D1 loader (REST + MCP parity): read the most recent BLOCKS_SUMMARY_SCAN_CAP
// blocks newest-first and shape them into the production summary. Cold/absent D1 →
// zeroed card. Exported for the MCP tool.
export async function loadBlocksSummary(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
): Promise<BlocksSummaryResult> {
  const rows = await d1(
    `SELECT ${BLOCKS_SUMMARY_READ_COLUMNS} FROM blocks ORDER BY block_number DESC LIMIT ?`,
    [BLOCKS_SUMMARY_SCAN_CAP],
  );
  return buildBlocksSummary(rows);
}
