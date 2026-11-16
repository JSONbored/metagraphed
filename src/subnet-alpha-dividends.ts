// The subnet-alpha-dividends serving builders (#13163) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces cannot
// drift. Pure + exported for tests; callers resolve the store (the native seam
// in subnet-alpha-dividends-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The accrual registry's writers -- the
// engine's SubtensorModule.AlphaDividendsPerSubnet /
// RootAlphaDividendsPerSubnet decode -- land separately (#13163 defers them),
// so an empty registry is not "no pending dividends": it is "the accrual
// capture has not run", and `hotkey_count: null` with an empty `dividends` is
// how the artifact says so. Amounts are u64 alpha atomic units as decimal
// strings; a missing amount stays null rather than claiming a measured zero.
import { selectedSubnetAlphaDividendsStore } from "./subnet-alpha-dividends-store.ts";

type Row = Record<string, unknown>;

const U64_MAX = 18446744073709551615n;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A u64 quantity as canonical decimal text; anything else is null. */
export function u64TextOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  return BigInt(value) <= U64_MAX ? value : null;
}

function formatDividend(row: Row): Row | null {
  const hotkey = typeof row?.hotkey === "string" ? row.hotkey : "";
  // A row without a hotkey names nothing; drop it rather than serve an
  // accrual that cannot be attributed.
  if (hotkey === "") return null;
  return {
    hotkey,
    alpha_divs: u64TextOrNull(row?.alpha_divs),
    root_alpha_divs: u64TextOrNull(row?.root_alpha_divs),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetAlphaDividends(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const dividends = (rows ?? [])
    .map((row) => formatDividend(row))
    .filter((row): row is Row => row !== null);
  // Newest stamp across the rows: the registry is written per hotkey, so one
  // capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const dividend of dividends) {
    const stamp = dividend.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    netuid,
    hotkey_count: dividends.length > 0 ? dividends.length : null,
    captured_at: newest,
    dividends,
  };
}

/**
 * One subnet's dividend rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetAlphaDividends(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetAlphaDividendsStore(env);
  if (!store) return null;
  try {
    return await store.rows(netuid);
  } catch (error) {
    console.error("subnet alpha dividends store read failed:", error);
    return null;
  }
}
