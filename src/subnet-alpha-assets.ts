// The subnet-alpha-assets serving builders (#13165) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces
// cannot drift. Pure + exported for tests; callers resolve the store (the
// native seam in subnet-alpha-assets-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The accounting's writers -- the engine's
// AlphaAssets.TotalAlphaIssuance / AlphaAssets.AlphaBurned /
// AlphaAssets.AlphaRecycled decode -- land separately (#13165 defers them),
// so an absent capture is not "this subnet has issued no alpha": it is "the
// alpha-assets capture has not run", and `alpha_assets: null` is how the
// artifact says so. Quantities are u64 atomic units as decimal strings.
import { selectedSubnetAlphaAssetsStore } from "./subnet-alpha-assets-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** One stored capture row to the published per-subnet alpha accounting. */
export function formatAlphaAssetsState(row: Row): Row {
  return {
    total_issuance: u64TextOrNull(row?.total_issuance),
    burned: u64TextOrNull(row?.burned),
    recycled: u64TextOrNull(row?.recycled),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetAlphaAssets(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const row = rows?.[0];
  const alphaAssets = row === undefined ? null : formatAlphaAssetsState(row);
  return {
    schema_version: 1,
    netuid,
    alpha_assets: alphaAssets,
    captured_at:
      alphaAssets === null ? null : (alphaAssets.captured_at as string | null),
  };
}

/**
 * One subnet's newest alpha-asset capture through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetAlphaAssets(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetAlphaAssetsStore(env);
  if (!store) return null;
  try {
    return await store.latest(netuid);
  } catch (error) {
    console.error("subnet alpha assets store read failed:", error);
    return null;
  }
}
