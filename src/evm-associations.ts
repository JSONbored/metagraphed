// The evm-associations serving builders (#13165) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool (all three serve the
// /evm/address/{h160} answer), so the surfaces cannot drift. Pure + exported
// for tests; callers resolve the store (the native seam in
// evm-associations-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The association history's writers -- the
// engine's SubtensorModule.AssociatedEvmAddress decode (event
// EvmKeyAssociated) -- land separately (#13165 defers them), so an empty
// result is not "this key was never associated": it is "the association
// capture has not run", and `association_count: null` with an empty
// `associations` is how the artifact says so. The precompile mapping stays
// the fallback answer for `ss58` -- it is a total function of the H160 and
// correct whether or not the storage path has data.
import { selectedEvmAssociationsStore } from "./evm-associations-store.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** One stored association row to its published shape, or null when the row
 * names no association the chain defines (no subnet/uid identity). */
export function formatEvmAssociation(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  const uid = nonNegativeInt(row?.uid);
  if (netuid === null || netuid > 65535 || uid === null || uid > 65535)
    return null;
  const ss58 =
    typeof row?.ss58 === "string" && row.ss58 !== "" ? row.ss58 : null;
  return {
    ss58,
    netuid,
    uid,
    associated_at: nonNegativeInt(row?.associated_at),
    captured_at: toIso(row?.captured_at),
  };
}

/** The association block of the /evm/address/{h160} answer. */
export function buildEvmAssociations(rows: readonly Row[] | null): {
  association_count: number | null;
  associations: Row[];
} {
  const associations = (rows ?? [])
    .map((row) => formatEvmAssociation(row))
    .filter((row): row is Row => row !== null);
  return {
    association_count: associations.length > 0 ? associations.length : null,
    associations,
  };
}

/**
 * One H160's association rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the live-RPC path never has.
 */
export async function loadEvmAssociations(
  env: unknown,
  h160: string,
): Promise<Row[] | null> {
  const store = selectedEvmAssociationsStore(env);
  if (!store) return null;
  try {
    return await store.byH160(h160.toLowerCase());
  } catch (error) {
    console.error("evm associations store read failed:", error);
    return null;
  }
}
