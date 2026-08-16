// The R2 SQL engine's response envelope (#11008).
//
// LIVES HERE, not beside the client, because this repo keeps schemas in one
// place -- the split that hid the lakehouse row schemas in `generated/` and the
// sync-row schemas in `src/` is the same one. A schema outside schemas-src is
// outside `no-passthrough`, `schema-shape-duplicates` and `schema-opacity`,
// which is exactly where an unreasoned open object survives.
import { z } from "zod";

/**
 * The engine's response envelope, PARSED rather than asserted.
 *
 * This used to be a hand-written interface behind a `JSON.parse(...) as
 * R2SqlBody` cast -- a shape this repo declared about somebody else's API and
 * then never checked. A cast is not a check: a body that had drifted, or an
 * HTML error page from a proxy, satisfied the compiler and reached the row
 * reader as `undefined` fields, which is how "no rows" and "we could not tell"
 * became the same answer.
 *
 * Loose on purpose -- unknown keys pass, because this is Cloudflare's envelope
 * and gaining a field is their business, not a fault here. What it pins is the
 * three fields this module actually reads, so a body that cannot answer them
 * is a classified decline instead of a silent empty.
 */
/**
 * What the engine reports a query COST, on every successful response.
 *
 * `bytes_scanned` is the number this repo has been arguing about without ever
 * reading. #10312's whole latency epic is stated in wall-clock, and wall-clock
 * cannot attribute it: measured 2026-08-16, the SAME query against the SAME
 * subject ran 2.00s and 31.61s in one session, a 15.8x spread that exceeded the
 * 9.4x spread BETWEEN the query shapes being compared. `cache_hits` in this
 * block is why.
 *
 * Scan cost does not move with cache state, so it is the figure a scan budget
 * can actually be set against -- the same figure
 * `scripts/validate-r2-sql-scan-bounds.ts` quotes from a manual probe
 * ("577.5 MB / 3,480 R2 requests" against "0.1 MB / 9") and which nothing has
 * been able to observe in production since.
 *
 * Every field OPTIONAL and the object EXPLICITLY open: this is Cloudflare's
 * envelope, so a metric they add must reach the caller rather than be stripped
 * by our schema, and a metric they remove must degrade the observability rather
 * than fail the read. `.catchall(z.unknown())` is the reviewed spelling of that
 * -- `.loose()` is the same behaviour without the statement, which is what
 * `validate:no-passthrough` refuses.
 */
const R2SqlMetricsSchema = z
  .object({
    /** Bytes the engine read to answer. The cost that matters. */
    bytes_scanned: z.number().optional(),
    /** Data files opened. R2 SQL has a real per-file cost -- see the
     * scan-bounds validator on why bucketing traded bytes for requests badly. */
    files_scanned: z.number().optional(),
    /** Requests made against R2 to serve this query. */
    r2_requests_count: z.number().optional(),
    /** How many of those were served from cache -- the variance the wall-clock
     * numbers were measuring. */
    cache_hits: z.number().optional(),
  })
  .catchall(z.unknown());

export type R2SqlMetrics = z.infer<typeof R2SqlMetricsSchema>;

export const R2SqlBodySchema = z.object({
  result: z
    .object({
      rows: z.unknown().optional(),
      metrics: R2SqlMetricsSchema.optional(),
    })
    .nullish(),
  success: z.boolean().optional(),
  errors: z
    .array(
      z.object({ code: z.number().optional(), message: z.string().optional() }),
    )
    .optional(),
});
