// The envelope every scheduled projection artifact carries (#9146).
//
// LIVES HERE for the reason chain-rpc-envelope.ts states: a schema outside
// schemas-src is outside `no-passthrough`, `schema-shape-duplicates` and
// `schema-opacity`, which is exactly where an unreasoned open object survives.
//
// PARSED, NOT CAST. The watchdog that reads these objects had:
//
//   const value = (body as { generated_at?: unknown } | null)?.generated_at;
//
// which types the access without checking a byte. These bodies come out of R2,
// were written by whatever deploy was live at the time, and are the sole input
// to the only alarm covering the projection lanes -- so "looks about right" is
// the wrong standard for the one thing that decides whether an operator is told.
import { z } from "zod";

/**
 * What a projection artifact must carry for the staleness watchdog to judge it.
 *
 * DELIBERATELY LOOSE ABOUT THE PAYLOAD. Each lane's body differs (`windows`,
 * `summary`, `rows`, ...) and this schema is not the place to state thirteen
 * shapes -- the reader only needs the two fields every lane writes. Zod strips
 * what it does not declare, so the payload is accepted and simply not carried
 * forward; `.passthrough()` would be openness without a reason and
 * `no-passthrough` rejects it, correctly.
 *
 * PER-FIELD `.catch(null)`, and that is the whole design. A body whose
 * `generated_at` is a number is not a body the watchdog should refuse to read:
 * it should read the field as UNREADABLE and let the rule say so, because
 * "absent" and "malformed" are already two of its four verdicts. Failing the
 * whole parse would collapse both into "the object could not be read", which is
 * the distinction the watchdog exists to draw.
 *
 * `row_count` is `.nullable()` rather than defaulted to 0, and the difference is
 * the point: a lane that does not report a count is not a lane that computed
 * none. Treating silence as zero would fire the empty-projection alarm on every
 * lane whose envelope predates the field.
 */
// NO INFERRED TYPE EXPORT. The one consumer reads the two fields straight off
// `safeParse` and needs no name for the pair, so exporting one would be a
// declaration nothing references -- which `validate:unreferenced-exports`
// ratchets on, and a ratchet only ever falls.
export const ProjectionArtifactEnvelopeSchema = z.object({
  generated_at: z.string().nullable().optional().catch(null),
  row_count: z.number().finite().nullable().optional().catch(null),
});
