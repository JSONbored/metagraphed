// Network-wide native-TAO transfer-pair analytics: over a recent window, which
// sender -> receiver corridors dominate Balances.Transfer flow. This is the pair
// companion to /chain/transfers (top individual senders/receivers) and
// /accounts/{ss58}/counterparties (one account's local relationships).
// Null-safe: a cold store or empty window yields a zeroed card.

export const CHAIN_TRANSFER_PAIR_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW = "7d";
export const CHAIN_TRANSFER_PAIR_LIMIT_DEFAULT = 25;
export const CHAIN_TRANSFER_PAIR_LIMIT_MAX = 100;
export const CHAIN_TRANSFER_PAIR_SORTS = ["volume", "count"];

const RAO_PER_TAO = 1e9;

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCount(value: unknown): number {
  return Math.max(0, Math.trunc(toNumber(value)));
}

function toBlockNumber(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function roundTao(value: unknown): number {
  const n = toNumber(value);
  return Math.round(n * RAO_PER_TAO) / RAO_PER_TAO;
}

function toNonNegativeTao(value: unknown): number {
  return Math.max(0, roundTao(value));
}

// Round a 0..1 dominance ratio to a stable precision WITHOUT letting a
// sub-perfect value round up to an exact 1 — the same anti-overstatement guard
// the sibling concentration/turnover ratios apply (roundRatio in
// src/concentration.mjs, round in src/chain-turnover.mjs). top_pair_volume_tao is
// the full-window MAX corridor and total_volume_tao the full-window SUM, so a
// near-monopoly (e.g. 249990/250000 = 0.99996, with other pairs still present in
// unique_pairs/pairs[]) must not surface as a flat 1 ("100% of volume"). A
// genuine single-corridor window where top == total keeps a true 1.
function roundShare(value: number, dp = 4): number {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeSort(sort: unknown): "volume" | "count" {
  return CHAIN_TRANSFER_PAIR_SORTS.includes(sort as string)
    ? (sort as "volume" | "count")
    : "volume";
}

export interface ChainTransferPair {
  from: string;
  to: string;
  volume_tao: number;
  transfer_count: number;
  last_block: number | null;
  last_observed_at: string | null;
}

function shapePairs(
  rows: Array<Record<string, unknown>> | null | undefined,
): ChainTransferPair[] {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const from = typeof row?.from === "string" ? row.from : row?.from_address;
      const to = typeof row?.to === "string" ? row.to : row?.to_address;
      return { row, from, to };
    })
    .filter(
      (
        entry,
      ): entry is {
        row: Record<string, unknown>;
        from: string;
        to: string;
      } =>
        typeof entry.from === "string" &&
        entry.from.length > 0 &&
        typeof entry.to === "string" &&
        entry.to.length > 0 &&
        entry.from !== entry.to,
    )
    .map(({ row, from, to }) => ({
      from,
      to,
      volume_tao: toNonNegativeTao(row.volume_tao),
      transfer_count: toCount(row.transfer_count),
      last_block: toBlockNumber(row.last_block),
      last_observed_at: toIso(row.last_observed_at),
    }));
}

export interface ChainTransferPairsResult {
  schema_version: 1;
  window: string | null;
  sort: "volume" | "count";
  observed_at: string | null;
  total_volume_tao: number;
  transfer_count: number;
  unique_pairs: number;
  pair_count: number;
  top_pair_share: number | null;
  pairs: ChainTransferPair[];
}

export function buildChainTransferPairs({
  window,
  sort = "volume",
  observedAt = null,
  totals = null,
  pairs = [],
}: {
  window?: string | null;
  sort?: unknown;
  observedAt?: string | null;
  totals?: Record<string, unknown> | null;
  pairs?: Array<Record<string, unknown>>;
} = {}): ChainTransferPairsResult {
  const topPairs = shapePairs(pairs);
  const totalVolume = toNonNegativeTao(totals?.total_volume_tao);
  const hasFullWindowTopPairVolume = Object.prototype.hasOwnProperty.call(
    totals ?? {},
    "top_pair_volume_tao",
  );
  const returnedTopPairVolume = topPairs.reduce(
    (max, pair) => Math.max(max, pair.volume_tao),
    0,
  );
  const topPairVolume = hasFullWindowTopPairVolume
    ? toNonNegativeTao(totals?.top_pair_volume_tao)
    : returnedTopPairVolume;
  const topPairShare =
    totalVolume > 0 ? roundShare(topPairVolume / totalVolume) : null;

  return {
    schema_version: 1,
    window: window ?? null,
    sort: normalizeSort(sort),
    observed_at: observedAt,
    total_volume_tao: totalVolume,
    transfer_count: toCount(totals?.transfer_count),
    unique_pairs: toCount(totals?.unique_pairs),
    pair_count: topPairs.length,
    top_pair_share: topPairShare,
    pairs: topPairs,
  };
}

// #4772 D1 retirement: loadChainTransferPairs (the D1 loader that read the
// account_events Transfer stream) was removed here -- that D1 write path is
// retired and the `account_events` table is dropped in production, so a live D1
// query would always miss. Serving now goes tryPostgresTier -> buildChainTransferPairs({}),
// never D1. See src/mcp-server.mjs's get_chain_transfer_pairs tool for the call site.
