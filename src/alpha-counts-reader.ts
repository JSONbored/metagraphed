import { selectedD1Store } from "./d1-store.ts";
import {
  alphaCountAnchorSchema,
  alphaCountsOwnerStore,
  type AlphaCountAnchor,
} from "./alpha-counts-d1.ts";

export interface CanonicalNominatorCountRow extends Record<string, unknown> {
  hotkey: string;
  nominator_count: number | null;
  scan_at: number | null;
}

export interface CanonicalNominatorCountCoverage {
  latest: number | null;
  covered: number;
  total: number;
}

const ANCHOR_COLUMNS = [
  "captured_at",
  "block_number",
  "block_hash",
  "genesis_hash",
  "spec_version",
  "code_hash",
  "metadata_sha256",
  "scanned_legacy",
  "scanned_v2",
  "distinct_members",
  "excluded_root_members",
] as const;

/** Discover old physical schemas before requiring the complete new owner.
 * Failed discovery never permits a legacy or cross-store fallback. */
async function context(env: unknown) {
  const discovery =
    selectedD1Store(env, ["nominator_positions"]) ??
    selectedD1Store(env, ["validator_nominator_counts"]) ??
    selectedD1Store(env, ["alpha_snapshot_passes"]);
  if (!discovery) return null;
  const table = await discovery.first<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='alpha_snapshot_passes'",
  );
  if (table?.name !== "alpha_snapshot_passes") return null;
  const store = alphaCountsOwnerStore(env);
  if (!store) {
    throw new Error("Alpha counts require their complete native owner");
  }
  const row = await store.first(
    `SELECT ${ANCHOR_COLUMNS.join(",")} FROM alpha_snapshot_passes
      WHERE selected=1 ORDER BY block_number DESC,captured_at DESC LIMIT 1`,
  );
  const parsed = alphaCountAnchorSchema.safeParse(row);
  return { store, anchor: parsed.success ? parsed.data : null };
}

/** Choose the newest capture before considering count readiness. The final
 * query checks that identity again atomically with the counts it returns.
 * Counts describe raw membership independently of economic valuation. */
function ready(anchor: AlphaCountAnchor) {
  const matches = ANCHOR_COLUMNS.map((column) => `c.${column} IS ?`).join(
    " AND ",
  );
  return {
    text: `WITH canonical AS MATERIALIZED (
      SELECT * FROM alpha_snapshot_passes WHERE selected=1
      ORDER BY block_number DESC,captured_at DESC LIMIT 1
    ), ready AS MATERIALIZED (
      SELECT c.captured_at FROM canonical c
      JOIN validator_nominator_counts_passes p USING(captured_at)
      JOIN alpha_runtime_metadata m ON m.sha256=c.metadata_sha256
        AND m.code_hash=c.code_hash AND m.spec_version=c.spec_version
      WHERE ${matches} AND p.alpha_snapshot=?
        AND c.completed_at>=c.captured_at
        AND c.received_rows=c.expected_rows
        AND c.received_chunks=c.expected_chunks
        AND p.completed_at>=c.captured_at
        AND p.expected_rows BETWEEN 0 AND c.distinct_members
        AND (p.expected_rows=0)=(c.distinct_members=0)
        AND p.received_rows=p.expected_rows
        AND (SELECT COUNT(*) FROM validator_nominator_counts
          WHERE captured_at=c.captured_at)=p.expected_rows
    )`,
    values: [
      ...ANCHOR_COLUMNS.map((column) => anchor[column]),
      JSON.stringify(anchor),
    ],
  };
}

/** Null means the additive schema is absent. An active but unavailable capture
 * returns no enrichment, so callers cannot borrow an older clock or owner. */
export async function readCanonicalNominatorCounts(
  env: unknown,
  hotkeys: readonly string[],
): Promise<CanonicalNominatorCountRow[] | null> {
  try {
    const state = await context(env);
    if (!state) return null;
    if (!state.anchor) return [];
    const query = ready(state.anchor);
    return await state.store.query<CanonicalNominatorCountRow>(
      query.text +
        ` SELECT k.value AS hotkey,p.nominator_count,r.captured_at AS scan_at
        FROM json_each(?) k LEFT JOIN ready r ON true
        LEFT JOIN validator_nominator_counts p
          ON p.hotkey=k.value AND p.captured_at=r.captured_at`,
      [...query.values, JSON.stringify([...new Set(hotkeys)])],
    );
  } catch {
    return [];
  }
}

/** Preserve the existing watchdog rule while counting only the canonical
 * capture. An incomplete anchored pass contributes no healthy coverage. */
export async function readCanonicalNominatorCountCoverage(
  env: unknown,
): Promise<CanonicalNominatorCountCoverage | null> {
  const state = await context(env);
  if (!state) return null;
  if (!state.anchor) return { latest: null, covered: 0, total: 0 };
  const query = ready(state.anchor);
  const row = await state.store.first<CanonicalNominatorCountCoverage>(
    query.text +
      ` SELECT c.captured_at AS latest,
      CASE WHEN EXISTS(SELECT 1 FROM ready) THEN
        (SELECT COUNT(*) FROM validator_nominator_counts
          WHERE captured_at=c.captured_at) ELSE 0 END AS covered,
      (SELECT COUNT(*) FROM validator_nominator_counts
        WHERE captured_at=c.captured_at) AS total
      FROM canonical c`,
    query.values,
  );
  return row ?? { latest: null, covered: 0, total: 0 };
}
