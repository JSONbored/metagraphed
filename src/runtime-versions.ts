// Block explorer runtime-upgrade history (#4316/3.1): the spec-version
// transition timeline, computed live off the first-party `blocks` D1 tier's
// spec_version column (migrations/0017_block_spec_version.sql) — no new
// capture, no migration, just an aggregate read. Pure + exported for unit
// tests; the Worker does the D1 read + envelope.
//
// Coverage caveat — be honest, not just "partial": spec_version was added to
// `blocks` via a nullable ALTER on 2026-06-25 (migration 0017), and the row
// load contract is INSERT OR IGNORE on the block_number primary key
// (src/blocks.ts) — a block row written before that date, or on any RPC
// failure, has a permanently-null spec_version that can never be back-filled
// by a later poller pass. `coverage_from_block`/`coverage_from_at` report the
// earliest block that DOES carry a reading, so a caller can tell "a version
// active before this block is invisible here" instead of reading a short
// transitions list as the network's whole runtime-upgrade history.
//
// That prefix-only disclosure was not enough, and said so honestly while
// still misleading: readings exist at BOTH ends of mainnet and are missing
// through the middle, so `coverage_from_block` reported 0 (genesis) while the
// timeline was missing ~4,000,000 blocks of upgrades — 23 recorded
// transitions against roughly 200 real ones. Verified against an archive node
// 2026-07-30: this endpoint had spec 217 active from block 4,600,000 to
// 8,599,188, while the chain ran spec 244 at block 5,000,000, 292 at
// 6,000,000, 348 at 7,000,000, 393 at 8,000,000 and 422 at 8,480,000.
// `coverage_complete`/`coverage_gaps` (see detectRuntimeCoverageGaps) expose
// interior holes, which a single coverage floor structurally cannot.

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Coerce a D1 cell to a non-negative integer, or null when missing,
// non-finite, or negative. D1 can return an INTEGER column as a numeric
// string, so a bare `row.spec_version ?? null` would silently leak the string
// into the API payload. Mirrors the `toBlockNumber` helper duplicated per
// module across src/blocks.ts, src/subnet-identity-history.ts, etc.
function toNonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface RuntimeTransition {
  spec_version: number;
  block_number: number;
  observed_at: string | null;
}

// One row -> one transition entry. A row whose spec_version/block_number
// can't be coerced is dropped rather than surfaced malformed — the aggregate
// query already filters `WHERE spec_version IS NOT NULL`, so this only guards
// against a D1 cell type surprise, not the expected null case.
export function formatRuntimeTransition(
  row: Row | null | undefined,
): RuntimeTransition | null {
  const specVersion = toNonNegativeInt(row?.spec_version);
  const blockNumber = toNonNegativeInt(row?.block_number);
  if (specVersion == null || blockNumber == null) return null;
  return {
    spec_version: specVersion,
    block_number: blockNumber,
    observed_at: toIso(row?.observed_at),
  };
}

// Shape the aggregated rows into the API data. `rows` is expected pre-sorted
// ascending by block_number (the SQL's ORDER BY) — the entry list preserves
// that order, so the first entry is the earliest reading this endpoint can
// see at all (coverage_from_block/coverage_from_at). `latestRow` is the
// separately-queried truly-latest block with a reading: current_spec_version
// is NOT taken from the last transitions entry, because GROUP BY collapses
// every occurrence of a spec_version into its EARLIEST block — if a version
// ever reappeared after a newer one was already observed (a runtime
// rollback), the last transitions entry would report the superseded version
// as current. current_spec_version can itself still lag/mislead if the most
// recent blocks failed to capture a reading (best-effort, see the module
// docstring) — it is the latest KNOWN reading, not a live guarantee.
export interface RuntimeCoverageGap {
  after_spec_version: number;
  before_spec_version: number;
  after_block: number;
  before_block: number;
  block_span: number;
}

export interface RuntimeVersionHistory {
  schema_version: 1;
  transitions: RuntimeTransition[];
  transition_count: number;
  current_spec_version: number | null;
  coverage_from_block: number | null;
  coverage_from_at: string | null;
  coverage_complete: boolean;
  coverage_gaps: RuntimeCoverageGap[];
}

// Largest block distance between two consecutive recorded transitions that is
// still consistent with complete coverage. Deliberately generous: mainnet has
// gone ~37k blocks (~5 days) between upgrades in normal operation, and quiet
// stretches are real, so this only fires on distances no upgrade cadence
// explains.
//
// Detection is by BLOCK DISTANCE, not by spec_version distance, because a
// spec_version skip is NOT evidence of missing data — releases that never
// reach mainnet leave real holes in the version sequence (mainnet went 424 →
// 432 → 437, skipping 425-431 and 433-436, with no data missing). Block
// distance has no such confound.
export const MAX_PLAUSIBLE_TRANSITION_BLOCK_SPAN = 500_000;

// Interior holes in the transition timeline. `coverage_from_block` alone
// cannot express these: it reports the earliest block carrying a reading, so
// a timeline that starts at genesis and then loses four million blocks in the
// middle still advertises `coverage_from_block: 0` and reads as complete
// history. That is exactly the live mainnet case — `blocks.spec_version` was
// added by a nullable ALTER (migration 0017) and never back-filled, leaving
// readings clustered at the two ends of the chain.
export function detectRuntimeCoverageGaps(
  transitions: RuntimeTransition[],
  maxSpan: number = MAX_PLAUSIBLE_TRANSITION_BLOCK_SPAN,
): RuntimeCoverageGap[] {
  const gaps: RuntimeCoverageGap[] = [];
  for (let i = 1; i < transitions.length; i += 1) {
    const prev = transitions[i - 1];
    const next = transitions[i];
    const span = next.block_number - prev.block_number;
    // Consecutive spec versions cannot bracket a missing transition: any
    // hidden upgrade would have to be to a version strictly between them, and
    // there is no integer between n and n+1. However far apart the blocks
    // are, that interval is simply a quiet stretch — one long-running
    // runtime, which is a fact about the chain, not a hole in our data.
    // (Real case after the #8756 backfill: spec 141 → 142 sat 571,805 blocks
    // apart and was reported as a gap purely on distance.)
    if (next.spec_version === prev.spec_version + 1) continue;
    if (span > maxSpan) {
      gaps.push({
        after_spec_version: prev.spec_version,
        before_spec_version: next.spec_version,
        after_block: prev.block_number,
        before_block: next.block_number,
        block_span: span,
      });
    }
  }
  return gaps;
}

export function buildRuntimeVersionHistory(
  rows: Row[] | null | undefined,
  latestRow: Row | null = null,
): RuntimeVersionHistory {
  const list = Array.isArray(rows) ? rows : [];
  const transitions = list
    .map(formatRuntimeTransition)
    .filter((entry): entry is RuntimeTransition => entry != null);
  const earliest = transitions[0] ?? null;
  const coverageGaps = detectRuntimeCoverageGaps(transitions);
  return {
    schema_version: 1,
    transitions,
    transition_count: transitions.length,
    current_spec_version: toNonNegativeInt(latestRow?.spec_version),
    coverage_from_block: earliest?.block_number ?? null,
    coverage_from_at: earliest?.observed_at ?? null,
    coverage_complete: coverageGaps.length === 0,
    coverage_gaps: coverageGaps,
  };
}

// One row per distinct spec_version: the earliest block that carried that
// reading. GROUP BY resolves the MIN(block_number) per version, then the
// outer ORDER BY sorts those group-boundary rows into a single ascending
// timeline — the same "boundary-point aggregate, not every row" shape as
// loadTurnoverBoundaryRows (src/turnover.ts), applied to a nullable column
// instead of a dated snapshot table.
const RUNTIME_TRANSITIONS_SQL =
  "SELECT spec_version, MIN(block_number) AS block_number, MIN(observed_at) AS observed_at FROM blocks WHERE spec_version IS NOT NULL GROUP BY spec_version ORDER BY block_number ASC";

// The truly-latest block carrying a reading, by block_number (the primary
// key) rather than by a spec_version's first appearance — deliberately a
// separate query from RUNTIME_TRANSITIONS_SQL's GROUP BY, which can't answer
// this (see buildRuntimeVersionHistory's docstring). Mirrors
// blocks-summary's `latest_spec_version: blocks[blockCount - 1].spec_version`
// (src/blocks-summary.ts), computed here via SQL instead of an in-memory
// window since this route has no window of rows already in hand.
const RUNTIME_LATEST_SQL =
  "SELECT spec_version FROM blocks WHERE spec_version IS NOT NULL ORDER BY block_number DESC LIMIT 1";

// Site-wide spec-version transition timeline — shared by the REST route.
// Cold/empty D1 (or a store with no spec_version reading yet) yields the
// schema-stable empty shape, never throws.
export async function loadRuntimeVersionHistory(
  d1: D1Runner,
): Promise<RuntimeVersionHistory> {
  const rows = await d1(RUNTIME_TRANSITIONS_SQL, []);
  const latestRows = await d1(RUNTIME_LATEST_SQL, []);
  return buildRuntimeVersionHistory(rows, latestRows[0] ?? null);
}
