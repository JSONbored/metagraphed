// Subnet tempo lookup (#2551) -- netuid -> tempo(blocks), sourced from
// subnet_hyperparams (migration 0036). Read/join lands here, mirroring
// src/validator-nominator-summary.ts's role for nominator_count; the read
// path lives in workers/data-api.mjs (loadSubnetTempos), joined into
// buildGlobalValidators/buildValidatorDetail's apy_estimate by netuid.

type Row = Record<string, unknown>;

// netuid -> tempo Map built from a Postgres query result, for
// accumulateApyRow (src/metagraph-neurons.ts) to annualize each subnet
// membership's emission_tao. Null-safe on a cold/absent table (returns an
// empty Map, so every lookup misses and apy_estimate serves as null) --
// never throws, mirrors nominatorCountsByHotkey's cold-safety.
export function tempoByNetuid(
  rows: Row[] | null | undefined,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = nonNegativeInt(row?.netuid);
    // tempo=0 would divide-by-zero into an infinite epochsPerYear downstream
    // -- treated the same as "unresolved" rather than a zero-length epoch,
    // so it's never stored at all.
    const tempo = nonNegativeInt(row?.tempo);
    if (netuid == null || tempo == null || tempo === 0) continue;
    map.set(netuid, tempo);
  }
  return map;
}

// Same coercion rules as src/metagraph-neurons.ts's own nonNegativeInt --
// duplicated locally rather than imported since that one isn't exported and
// this module should stay independently testable/importable without pulling
// in metagraph-neurons.ts's whole surface.
function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
