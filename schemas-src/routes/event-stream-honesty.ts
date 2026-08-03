// The two additive blocks a route uses to say something about its own answer
// instead of publishing a confident zero (#9307).
//
// Both are OPTIONAL and absent from every trustworthy answer, so a consumer
// that ignores them reads exactly what it read before -- the same
// wire-compatibility argument src/account-nominator-positions.ts's `degraded`
// block already makes.
//
// Deliberately NOT registered as named OpenAPI components: they are new
// shapes with no hand-edited predecessor to keep a name compatible with, so
// z.toJSONSchema inlines them into each artifact that carries one. See
// schemas-src/openapi-registry.ts's header for when a leaf DOES need
// registering.
import { z } from "zod";

/** A route's own statement that its zero is not a measurement. */
export const EventStreamDegradedSchema = z
  .object({
    reason: z.string(),
    detail: z.string().optional(),
  })
  .strict();

/**
 * How a deregistration feed was derived.
 *
 * `unattributed_registrations` is the load-bearing field: the published totals
 * are a LOWER BOUND by that many events, because those registrations displaced
 * a holder the derivation's lookback cannot name.
 */
export const DeregistrationDerivationSchema = z
  .object({
    method: z.string(),
    lookback_days: z.int().min(0),
    window_registrations: z.int().min(0),
    unattributed_registrations: z.int().min(0),
  })
  .strict();
