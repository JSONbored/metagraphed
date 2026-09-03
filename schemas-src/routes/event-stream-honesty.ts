// The two additive blocks a route uses to say something about its own answer
// instead of publishing a confident zero (#9307).
//
// Both are OPTIONAL and absent from every trustworthy answer, so a consumer
// that ignores them reads exactly what it read before -- the same
// wire-compatibility argument src/account-nominator-positions.ts's `degraded`
// block already makes.
//
// Both ARE registered as named OpenAPI components (#10214). They were not,
// on the reasoning that a new shape with no hand-edited predecessor has no
// name to stay compatible with -- true, and the wrong test. Registration is
// not only about preserving an old name: an unregistered schema is INLINED by
// z.toJSONSchema at every use, which erases the fact that the 17 artifacts
// carrying a `degraded` block carry the SAME block. Every generator reading
// the JSON Schema then re-derives a name per occurrence -- which is why the
// GraphQL emitter invented 11 names for this one shape and a hand-maintained
// table mapped them all back to `DegradedInfo`.
//
// Register a shape that is USED MORE THAN ONCE, whatever its history. See
// schemas-src/openapi-registry.ts's header for the rest of the rule.
import { z } from "zod";

/** A route's own statement that its zero is not a measurement. */
// CARRIED AS `.nullable().optional()` BY EVERY FIELD THAT USES IT (#10786).
//
// It was `.optional()` alone, which admits `undefined` and REJECTS `null` --
// while all ten producers write `degraded: data.degraded ?? null` on the
// degraded read this block exists to describe. GraphQL has no `undefined`: a
// field is a value or it is null, so null IS the absent-spelling on the surface
// that enforces this at execution. The schema described a shape none of its
// producers could emit when the thing it reports actually happened.
export const EventStreamDegradedSchema = z
  .object({
    reason: z.string(),
    detail: z.string().optional(),
  })
  .strict()
  .describe(
    "An event-derived result could not be measured because its source is unavailable, its stream was never emitted, or its derivation could not answer this request. Absent on measured answers, including successfully read quiet windows.",
  );

/**
 * The narrow form: a decline whose only possible reason is that the read could
 * not be answered at all. Three routes had written this exact object inline
 * (#10214), so the published schema carried three names for one shape.
 */
export const UnavailableDegradedSchema = z
  .object({ reason: z.enum(["unavailable"]) })
  .strict()
  .describe(
    "Present ONLY on a decline. An empty result WITHOUT this block is a measurement, not a decline.",
  );

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
    lookback_days: z
      .int()
      .min(0)
      .describe(
        "Days of NeuronRegistered history the derivation had available.",
      ),
    window_registrations: z
      .int()
      .min(0)
      .describe("Registrations observed inside the reported window."),
    unattributed_registrations: z
      .int()
      .min(0)
      .describe("Of those, the ones with no observed previous holder."),
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
  .strict()
  .describe(
    "How a deregistration feed was derived (#9307). NeuronDeregistered has never been emitted, so deregistrations are derived from UID reuse: a NeuronRegistered on a (netuid, uid) slot already held by a different hotkey IS the deregistration of the previous occupant. unattributed_registrations is the honest part -- the published totals are a LOWER BOUND by that many events, because those registrations displaced a holder the derivation's lookback cannot name.",
  );
