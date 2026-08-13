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
export const R2SqlBodySchema = z.object({
  result: z
    .object({
      rows: z.unknown().optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
    })
    .nullish(),
  success: z.boolean().optional(),
  errors: z
    .array(
      z.object({ code: z.number().optional(), message: z.string().optional() }),
    )
    .optional(),
});
