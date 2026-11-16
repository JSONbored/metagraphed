// The subnet-mechanisms serving builders (#13162) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces cannot
// drift. Pure + exported for tests; callers resolve the store (the native seam
// in subnet-mechanisms-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. Every subnet has at least mechanism 0, so
// an empty registry is not "this subnet has no mechanisms" -- it is "the
// per-mechanism capture has not run" (the engine dependency #13162 defers),
// and `mechanism_count: null` with an empty `mechanisms` is how the artifact
// says so. See SubnetMechanismsArtifactSchema's own field comment.
import { selectedSubnetMechanismsStore } from "./subnet-mechanisms-store.ts";

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

/** An emission split only in the 0..1 the chain defines; anything else is null. */
function splitOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function formatMechanism(row: Row): Row | null {
  const mechid = nonNegativeInt(row?.mechid);
  // A row without a usable mechid names nothing; drop it rather than serve a
  // mechanism that cannot be addressed.
  if (mechid == null) return null;
  return {
    mechid,
    emission_split: splitOrNull(row?.emission_split),
    consensus_mode:
      typeof row?.consensus_mode === "string" && row.consensus_mode !== ""
        ? row.consensus_mode
        : null,
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetMechanisms(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const mechanisms = (rows ?? [])
    .map((row) => formatMechanism(row))
    .filter((row): row is Row => row !== null)
    .sort((a, b) => (a.mechid as number) - (b.mechid as number));
  // Newest stamp across the rows: the registry is written per mechanism, so
  // one capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const mechanism of mechanisms) {
    const stamp = mechanism.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    netuid,
    mechanism_count: mechanisms.length > 0 ? mechanisms.length : null,
    captured_at: newest,
    mechanisms,
  };
}

/**
 * One subnet's mechanism rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling neuron routes never have.
 */
export async function loadSubnetMechanisms(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetMechanismsStore(env);
  if (!store) return null;
  try {
    return await store.rows(netuid);
  } catch (error) {
    console.error("subnet mechanisms store read failed:", error);
    return null;
  }
}
