// Shared request query-parameter parsing for the entity/list + feed handlers.
//
// Every paginated route used to clamp `limit`/`offset` and read the keyset
// `cursor` with its own inline `clampInt(...)` calls and literal bounds, so the
// caps drifted between handlers (and a fix in one route never reached the others).
// This module is the single place those rules live: the absolute bounds are named
// constants, the per-route page-size pairs are named profiles, and `parsePagination`
// returns the same `{ limit, offset, cursor }` shape for every handler -- or a
// ParamError, since an out-of-range `limit` is rejected rather than clamped (#9916). The raw
// `clampLimit`/`clampOffset` primitives let the shared D1 loaders + MCP tools clamp
// identically off plain values (they never see a URL).
//
// Import-free apart from `clampInt`, so it stays a leaf the request handlers and
// the src/* loaders can both depend on without a cycle.

import { clampInt } from "./config.ts";

// Absolute pagination ceilings, shared by every paginated route + tool. A page is
// never larger than MAX_LIMIT rows, and OFFSET never seeks past MAX_OFFSET (deep
// pages should use the keyset cursor instead).
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 1000;
export const MAX_OFFSET = 1_000_000;
// The standard page size when a caller omits `limit` (also the in-memory list
// collections' default).
export const DEFAULT_LIMIT = 100;

// Named (default, max) page-size profiles. The standard entity/event feeds default
// to DEFAULT_LIMIT and cap at MAX_LIMIT; the block-explorer feeds carry wider rows
// so they default to 50 and cap tighter at 100. Both share the MAX_OFFSET ceiling.
export const FEED_PAGINATION = {
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
};
export const BLOCK_PAGINATION = { defaultLimit: 50, maxLimit: 100 };

export interface PaginationProfile {
  defaultLimit?: number;
  maxLimit?: number;
}

export interface ParamError {
  error: { parameter: string; message: string };
}

// Clamp a raw limit (a query-param string or a tool-arg number) into
// [MIN_LIMIT, maxLimit], falling back to defaultLimit when absent/blank/non-finite.
export function clampLimit(
  raw: string | number | null | undefined,
  {
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = MAX_LIMIT,
  }: PaginationProfile = {},
): number {
  return clampInt(raw, defaultLimit, MIN_LIMIT, maxLimit);
}

/**
 * The TOOL page-size rule: below 1, non-finite or non-numeric falls back to the
 * default — it must never clamp UP to 1.
 *
 * A second rule rather than a variant of `clampLimit`, because the difference
 * is deliberate and load-bearing. `clampLimit` goes through `clampInt`, which
 * does `Math.max(min, …)`; `tools/call` does not enforce the inputSchema's
 * `minimum`, so an explicit `limit: 0` reaches the loader, and clamping it up
 * would answer with a SINGLE row — which reads to an agent as "this registry
 * knows one subnet" rather than "you asked for none".
 *
 * Exported because 18 modules had each written this out privately: 17
 * byte-identical copies plus `src/mcp-server.ts`'s, which is the one carrying
 * the comment that explains them all. This module's own header already said
 * the raw primitives exist so "the shared D1 loaders + MCP tools clamp
 * identically off plain values" — they just could not reach a rule that was
 * never exported.
 */
export function clampToolLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

/**
 * The BUILDER page-size rule: clamp into [0, max], falling back to the default
 * only when the value is not a finite number.
 *
 * The third of three, and the difference from `clampToolLimit` is the zero.
 * These are pure row-shaping builders running BEHIND a handler that has
 * already validated the request, so `limit: 0` reaching one is a caller who
 * genuinely asked for no rows, not the unenforced `minimum` that made the tool
 * rule fall back. Clamping 0 up would hand back a row nobody asked for.
 *
 * Exported because 17 modules had written the same four lines inline, each
 * with its own pair of constants:
 *
 *   const flooredLimit = Math.floor(Number(limit));
 *   const normalizedLimit = Number.isFinite(flooredLimit)
 *     ? Math.max(0, Math.min(flooredLimit, X_LIMIT_MAX))
 *     : X_LIMIT_DEFAULT;
 */
export function clampRowLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const floored = Math.floor(Number(value));
  return Number.isFinite(floored)
    ? Math.max(0, Math.min(floored, max))
    : fallback;
}

// Clamp a raw offset into [0, MAX_OFFSET], falling back to 0 when
// absent/blank/non-finite.
export function clampOffset(raw: string | number | null | undefined): number {
  return clampInt(raw, 0, 0, MAX_OFFSET);
}

/**
 * `parsePagination`, `parseLimitParam`, `parseNonNegativeIntParam`,
 * `parseNetuidParam` and `parseDateRange` lived here until #10218.
 *
 * Each restated, in TypeScript, a bound the route already publishes in Zod --
 * and only ran where a handler remembered to call it, which is how
 * `?offset=notanumber` answered 200 from row 0 on ten routes while
 * `?limit=notanumber` on the same request 400'd. The router now parses every
 * GET's query against the route's own schema before dispatch
 * (`src/route-query.ts`), so the bound is enforced once, from the declaration
 * that publishes it, on every route rather than on the ones that opted in.
 *
 * What survives here is deliberately NOT validation: `clampLimit`,
 * `clampToolLimit` and `clampRowLimit` are row-shaping rules applied BEHIND a
 * boundary that has already validated, off plain values that never came from a
 * URL. `DAY_PATTERN` survives as the MCP handler guards' shared shape, which is
 * where MCP's enforcement deliberately lives (#8942).
 */

// A bare, anchored YYYY-MM-DD calendar date — the shape the date-bounded feeds use
// for their TEXT `day` columns (lexicographic = chronological). Format-only: it
// does not range-check the month/day fields.
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
