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
    // #9708: the same fact, machine-readable. The prose above and
    // `unattributed_registrations` have said "lower bound" since #9307, but
    // only to a human reading docs -- the payload published a bare count, and
    // a bare count reads as a measurement. Measured on mainnet 2026-08-07
    // against subnets with no free UIDs, where every registration must
    // displace someone: SN64 published 0 deregistrations against 24
    // registrations, SN51 0 against 26, SN120 219 against 470, SN53 287
    // against 540. A reader took the zeros to mean "no churn" -- the opposite
    // of the truth -- and nothing in the response contradicted them.
    is_lower_bound: z
      .boolean()
      .describe(
        "True when the count is a floor rather than a measurement: some " +
          "registrations in the window displaced a holder the derivation's " +
          "lookback cannot name, so the real figure is higher by at least " +
          "`unattributed_registrations`. Treat the value as 'at least this " +
          "many', never as a total.",
      )
      .meta({ examples: [true] }),
  })
  .strict();
