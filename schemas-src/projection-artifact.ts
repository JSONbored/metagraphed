// The envelope every SCHEDULED PROJECTION lane writes to R2, PARSED rather
// than asserted (#11418).
//
// ## Why this exists
//
// Nineteen readers under `src/*-artifact.ts` each restated the same parse --
// `schema_version`, `windows`, the window label, the window cell, the row
// array, the aggregate cell -- behind `as` casts, and each documented the
// contract in PROSE: "same contract as its twelve siblings". Prose is not a
// single source. It cannot be checked, so a reader that drifted from it kept
// compiling, and the sentence stayed true-looking while counting the wrong
// number of siblings.
//
// A cast is not a check either. It is this repo asserting a shape over bytes
// it did not write in this process -- the same mistake
// `schemas-src/r2-sql-envelope.ts` was written to undo for the engine's
// response envelope, and it lives here for the same reason: a schema outside
// schemas-src is outside `no-passthrough`, `schema-shape-duplicates` and
// `schema-opacity`.
//
// ## What is pinned, and what is deliberately open
//
// The ROWS are open objects on purpose. Their fields belong to the SQL that
// produced them and to the builders that read them, and those two already
// agree; pinning the column list a third time here would mean a rename had to
// land in three places or the read would decline against data that is fine.
//
// What IS pinned is the structure the readers branch on, because that is where
// the casts were hiding real decisions -- `!Array.isArray(win?.rows)` and
// `typeof chainWide !== "object"` were the only things standing between a
// malformed artifact and a builder handed garbage.
//
// ## This is STRICTER than what it replaces
//
// `typeof x === "object"` accepts an array and accepts a row array whose
// elements are `null`. Both reached the builders as fields that read
// `undefined`, which is how "the lane wrote nonsense" and "the window is quiet"
// became the same answer. `z.record` declines an array; `z.array(z.record())`
// declines a non-object element. Measured 2026-08-16: the worst case in the
// fleet (the weight-setters lane at `ROLLUP_POPULATION_CAP` = 1000 rows x 8
// columns) parses in 1.26ms, against the 2.00s-31.61s request-time lakehouse
// read the lane exists to remove.
import { z } from "zod";

/**
 * One stored row -- an open object, read by field name downstream.
 *
 * Also the shape of an aggregate cell: the lanes store `networkRows[0]`, a
 * single row, under `network` or `totals`.
 */
export const ProjectionRowSchema = z.record(z.string(), z.unknown());
export type ProjectionRow = z.infer<typeof ProjectionRowSchema>;

/** A stored row array. Every element must be an object or the read declines. */
export const ProjectionRowsSchema = z.array(ProjectionRowSchema);

/**
 * A chain-wide aggregate cell.
 *
 * ABSENT and NULL both mean "the lane found none" and normalize to null, which
 * is what the loaders stored (`networkRows[0] ?? null`). Anything that is not
 * an object is the artifact being wrong, and declines.
 */
export const ProjectionAggregateSchema =
  ProjectionRowSchema.nullable().default(null);

/**
 * The envelope, minus the window cells.
 *
 * `windows` stays `unknown`-valued here because each lane's cell shape differs
 * and is parsed by the caller's own cell schema -- validating it twice would
 * copy every row twice.
 *
 * `generated_at` is OPTIONAL rather than required, and that is a deliberate
 * split: readers that surface it use it to report WHEN the projection was
 * computed, so a stalled lane reads as stale instead of as fresh zeros. A lane
 * that omitted it is still readable -- the timestamp is missing, which the
 * reader reports as null, and that is a different thing from the artifact being
 * malformed. `row_count` is stored but never read, so it is stripped.
 */
export const ProjectionEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().optional(),
  windows: z.record(z.string(), z.unknown()),
});

/**
 * The commonest cell: per-subnet rows plus the optional chain-wide DISTINCT
 * row. Serving, prometheus, weights, stake-moves, stake-transfers and
 * registrations all store exactly this.
 */
export const ProjectionRowsWithAggregateCellSchema = z.object({
  rows: ProjectionRowsSchema,
  network: ProjectionAggregateSchema,
});

/** A cell carrying only rows -- alpha-volume, stake-flow. */
export const ProjectionRowsCellSchema = z.object({
  rows: ProjectionRowsSchema,
});

/**
 * A leaderboard cell: rows plus the window's UNGROUPED totals.
 *
 * The totals ride separately from the rows because the page is capped by
 * `limit`, so a share computed against a summed page would grow as the page
 * shrank. A cell without them declines rather than publishing shares of
 * nothing -- unlike the aggregate above, this one the builder cannot fall back
 * from.
 */
export const ProjectionRowsWithTotalsCellSchema = z.object({
  rows: ProjectionRowsSchema,
  totals: ProjectionRowSchema,
});
