import { z } from "zod";
import type { D1StoreBinding } from "./d1-store.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { BLOCKS_COLUMNS } from "../generated/lakehouse/types.ts";
import { BlocksRowSchema } from "../schemas-src/lakehouse.ts";

export interface RetainedBlocksEnv {
  D1_RETAINED_BLOCKS?: D1StoreBinding;
  RETAINED_BLOCKS_NETWORKS?: string;
}
const integer = z.number().int().nonnegative().safe();
const State = z.object({
  network: z.union([z.literal(0), z.literal(1)]),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  table_uuid: z.string().uuid(),
  snapshot: z.string().regex(/^[0-9]+$/),
  sequence: integer,
  generated_at: integer,
  source_rows: integer,
  source_files: integer.max(32768),
  coverage: z.string().nullable(),
});
const Counts = z.object({
  kind: z.enum(["events", "extrinsics"]),
  matches: integer,
});
const HeightBounds = z.object({
  first_block: z.number().int().safe().nullable(),
  last_block: z.number().int().safe().nullable(),
});

function blockRange(where: readonly string[]) {
  const clauses: string[] = [];
  let lower: number | undefined, upper: number | undefined;
  for (const clause of where) {
    const bound = /^block_number\s*(>=|<=|<)\s*(\d+)$/.exec(clause);
    if (!bound) {
      clauses.push(clause);
      continue;
    }
    const value = Number(bound[2]);
    if (bound[1] === ">=") lower = Math.max(lower ?? value, value);
    else {
      const inclusive = value - (bound[1] === "<" ? 1 : 0);
      upper = Math.min(upper ?? inclusive, inclusive);
    }
  }
  if (lower !== undefined) clauses.push(`block_number >= ${lower}`);
  if (upper !== undefined) clauses.push(`block_number <= ${upper}`);
  return { clauses, lower, upper };
}
function checkedState(value: unknown, net: number, now: number) {
  const state = State.parse(value);
  if (
    state.network !== net ||
    state.generated_at > now ||
    now - state.generated_at > 7200000 ||
    state.source_files > state.source_rows ||
    (state.source_files === 0 && state.source_rows !== 0)
  )
    throw new Error("Retained block snapshot receipt is invalid");
  return state;
}

/** `where` is constructed only by the existing block-feed input guards.
 * Both stores execute exactly the same predicates and tuple ordering. The
 * D1 batch pins the selected source membership and receipt to the same read.
 */
export async function readRetainedBlockRows(
  env: RetainedBlocksEnv | null | undefined,
  where: readonly string[],
  count: number,
  network: ChainNetworkId = "mainnet",
  now = Date.now(),
  minimums: { minEvents?: number | null; minExtrinsics?: number | null } = {},
): Promise<Record<string, unknown>[] | null | undefined> {
  if (!env?.RETAINED_BLOCKS_NETWORKS?.split(",").includes(network))
    return undefined;
  try {
    const db = env.D1_RETAINED_BLOCKS;
    if (!db) return null;
    const net = network === "mainnet" ? 0 : 1;
    const stateQuery = () =>
      db.prepare("SELECT * FROM history_block_state WHERE network=?").bind(net);
    const range = blockRange(where);
    const author = where.some((clause) => clause.startsWith("author = "));
    const spec = where.some((clause) => /^spec_version\s*=/.test(clause));
    const ordered = author
      ? spec
        ? "author_spec"
        : "author"
      : spec
        ? "spec"
        : "order";
    let index = ` INDEXED BY history_blocks_${ordered}`;
    const chooseHeight =
      !author &&
      !spec &&
      (range.lower !== undefined || range.upper !== undefined) &&
      !where.some((clause) => clause.includes("observed_at"));
    // Read both ends through the height index, not COUNT(*) over the range.
    // The selected receipt and source membership share this batch. An empty
    // or entirely nullable height set cannot match an integer height filter.
    const heightEnd = (direction: "ASC" | "DESC") =>
      "CASE WHEN EXISTS(SELECT 1 FROM history_block_state WHERE network=?) THEN " +
      "(SELECT block_number FROM history_blocks b INDEXED BY history_blocks_height " +
      "WHERE b.network=? AND block_number IS NOT NULL AND b.source_id IN " +
      "(SELECT id FROM history_block_sources WHERE network=? AND active=1) " +
      `ORDER BY block_number ${direction} LIMIT 1) END`;
    const filters = [
      ["events", minimums.minEvents],
      ["extrinsics", minimums.minExtrinsics],
    ] as const;
    const selected = filters.filter(([, minimum]) => minimum != null);
    let generation: string | undefined;
    if (selected.length || chooseHeight) {
      // Complete per-source histograms are combined with snapshot selection.
      // Their cardinalities avoid both an empty-result scan and a sort over a
      // common count range. No request counts millions of block rows.
      const [receipt, ...results] = await db.batch([
        stateQuery(),
        ...selected.map(([kind, minimum]) =>
          db
            .prepare(
              "SELECT ? AS kind,COALESCE(SUM(rows),0) AS matches FROM history_block_counts WHERE network=? AND kind=? AND value>=?",
            )
            .bind(kind, net, kind, minimum),
        ),
        ...(chooseHeight
          ? [
              db
                .prepare(
                  `SELECT ${heightEnd("ASC")} AS first_block,${heightEnd("DESC")} AS last_block`,
                )
                .bind(net, net, net, net, net, net),
            ]
          : []),
      ]);
      if (!receipt!.success || results.some((result) => !result.success))
        return null;
      const state = checkedState(receipt!.results[0], net, now);
      generation = state.generation;
      if (chooseHeight) {
        const bounds = HeightBounds.parse(results.at(-1)!.results[0]);
        if (bounds.first_block === null && bounds.last_block === null)
          return [];
        if (
          bounds.first_block === null ||
          bounds.last_block === null ||
          bounds.first_block > bounds.last_block
        )
          return null;
        const lower = Math.max(
          range.lower ?? bounds.first_block,
          bounds.first_block,
        );
        const upper = Math.min(
          range.upper ?? bounds.last_block,
          bounds.last_block,
        );
        if (lower > upper) return [];
        // Broad upper bounds (including the hot/cold seam) must not sort the
        // whole retained table. Narrower ranges benefit from the height index.
        // This is a plan choice only; every original predicate remains exact.
        if (upper - lower < (bounds.last_block - bounds.first_block) / 2)
          index = " INDEXED BY history_blocks_height";
      }
      const counts = results
        .slice(0, selected.length)
        .map((result) => Counts.parse(result.results[0]))
        .sort((a, b) => a.matches - b.matches);
      if (counts[0]?.matches === 0) return [];
      if (counts[0] && counts[0].matches <= 50000)
        index = ` INDEXED BY history_blocks_${counts[0]!.kind}`;
    }
    // Explicit null placement matches the original PostgreSQL/DataFusion
    // descending order; SQLite's default places these nulls last instead.
    const [receipt, result] = await db.batch([
      stateQuery(),
      db
        .prepare(
          `WITH candidates AS MATERIALIZED (SELECT b.source_id,b.ordinal FROM history_blocks b${index} ` +
            (author
              ? "JOIN history_block_authors a ON a.id=b.author_id "
              : "") +
            "WHERE b.network=? " +
            "AND b.source_id IN (SELECT id FROM history_block_sources WHERE network=? AND active=1)" +
            (range.clauses.length
              ? ` AND ${range.clauses.map((clause) => (clause.startsWith("author = ") ? `a.address${clause.slice(6)}` : clause)).join(" AND ")}`
              : "") +
            " ORDER BY observed_at DESC NULLS FIRST, block_number DESC NULLS FIRST LIMIT ?) " +
            `SELECT ${BLOCKS_COLUMNS.map((column) => (column === "author" ? "a.address AS author" : `b.${column}`)).join(", ")} ` +
            "FROM candidates c JOIN history_blocks b ON b.source_id=c.source_id AND b.ordinal=c.ordinal " +
            "LEFT JOIN history_block_authors a ON a.id=b.author_id ORDER BY b.observed_at DESC NULLS FIRST,b.block_number DESC NULLS FIRST",
        )
        .bind(net, net, count),
    ]);
    if (!receipt!.success || !result!.success) return null;
    const state = checkedState(receipt!.results[0], net, now);
    if (generation !== undefined && generation !== state.generation)
      return null;
    return BlocksRowSchema.required().array().parse(result!.results);
  } catch {
    return null;
  }
}
