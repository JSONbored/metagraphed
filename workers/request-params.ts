// Shared request query-parameter parsing for the entity/list + feed handlers.
//
// Every paginated route used to clamp `limit`/`offset` and read the keyset
// `cursor` with its own inline `clampInt(...)` calls and literal bounds, so the
// caps drifted between handlers (and a fix in one route never reached the others).
// This module is the single place those rules live: the absolute bounds are named
// constants, the per-route page-size pairs are named profiles, and `parsePagination`
// returns the same `{ limit, offset, cursor }` shape for every handler. The raw
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
  { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT }: PaginationProfile = {},
): number {
  return clampInt(raw, defaultLimit, MIN_LIMIT, maxLimit);
}

// Clamp a raw offset into [0, MAX_OFFSET], falling back to 0 when
// absent/blank/non-finite.
export function clampOffset(raw: string | number | null | undefined): number {
  return clampInt(raw, 0, 0, MAX_OFFSET);
}

// Parse the shared pagination triplet from a request URL: a clamped `limit`, a
// clamped `offset`, and the raw opaque keyset `cursor` (or null) for the caller to
// decode at its own arity. `options` is a page-size profile ({ defaultLimit,
// maxLimit }), e.g. FEED_PAGINATION or BLOCK_PAGINATION.
export function parsePagination(
  url: URL,
  options: PaginationProfile = {},
): { limit: number; offset: number; cursor: string | null } {
  const params = url.searchParams;
  return {
    limit: clampLimit(params.get("limit"), options),
    offset: clampOffset(params.get("offset")),
    cursor: params.get("cursor"),
  };
}

// Validate + resolve a `limit` for the analytics routes that REJECT an
// out-of-range value with a 400 rather than silently clamping it. An absent limit
// falls back to defaultLimit; a present limit must be a positive integer (no
// leading zero) of at most maxLimit, else an { error } descriptor is returned for
// the caller to surface via its query-error helper. Returns { limit } on success.
export function parseLimitParam(
  url: URL,
  { defaultLimit, maxLimit = MAX_LIMIT }: PaginationProfile = {},
): { limit: number | undefined } | ParamError {
  const raw = url.searchParams.get("limit");
  if (raw === null) return { limit: defaultLimit };
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > maxLimit) {
    return {
      error: {
        parameter: "limit",
        message: `limit must be an integer between ${MIN_LIMIT} and ${maxLimit}.`,
      },
    };
  }
  return { limit: Number(raw) };
}

// A bare, anchored YYYY-MM-DD calendar date — the shape the date-bounded feeds use
// for their TEXT `day` columns (lexicographic = chronological). Format-only: it
// does not range-check the month/day fields.
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Validate optional YYYY-MM-DD `from`/`to` bounds on a request URL. An absent or
// blank bound means "no bound" (normalized to null); a present-but-malformed bound
// returns { error } with the shared message. On success returns { from, to } ready
// to bind into a `day >= ?` / `day <= ?` range.
// Validate an optional non-negative integer query value. Absent/blank → { value:
// null }; present-but-non-numeric → { error } for the caller to surface as 400.
export function parseNonNegativeIntParam(
  raw: string | null,
  parameter: string,
): { value: number | null } | ParamError {
  if (raw === null || raw === "") return { value: null };
  if (!/^\d+$/.test(raw)) {
    return {
      error: {
        parameter,
        message: `${parameter} must be a non-negative integer.`,
      },
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return {
      error: {
        parameter,
        message: `${parameter} must be a non-negative integer.`,
      },
    };
  }
  return { value };
}

export function parseDateRange(
  url: URL,
): { from: string | null; to: string | null } | ParamError {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && !DAY_PATTERN.test(from)) {
    return {
      error: { parameter: "from", message: "from must be a YYYY-MM-DD date." },
    };
  }
  if (to && !DAY_PATTERN.test(to)) {
    return {
      error: { parameter: "to", message: "to must be a YYYY-MM-DD date." },
    };
  }
  return { from: from || null, to: to || null };
}
