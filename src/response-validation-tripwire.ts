// Staging drift tripwire (types-epic B, #7860 requirement 6): when
// METAGRAPH_VALIDATE_RESPONSES="true", parse a covered route's outgoing
// envelope against its schemas-src/ Zod schema and log (never throw) on
// mismatch. Default OFF, zero-cost when unset: the caller must check the
// env flag BEFORE calling this function at all (see workers/api.ts's call
// site) so the flag check itself never even reaches this module -- and the
// schema import below is dynamic so it's only evaluated once the flag is
// actually on, not on every request.
//
// Only wired for the routes schemas-src/ currently covers (types-epic A's
// 5 pilots) -- add an entry here as later types-epic B batches convert more
// routes (see .claude/skills/metagraphed/reference.md's Zod-owned-components
// note).
const SCHEMA_LOADERS: Record<
  string,
  () => Promise<{
    safeParse: (value: unknown) => { success: boolean; error?: unknown };
  }>
> = {
  subnets: async () =>
    (await import("../schemas-src/routes/subnets.ts")).SubnetsResponseSchema,
  "subnet-detail": async () =>
    (await import("../schemas-src/routes/subnet-detail.ts"))
      .SubnetDetailResponseSchema,
  health: async () =>
    (await import("../schemas-src/routes/health.ts")).HealthResponseSchema,
  economics: async () =>
    (await import("../schemas-src/routes/economics.ts"))
      .EconomicsResponseSchema,
  "subnet-stake-quote": async () =>
    (await import("../schemas-src/routes/stake-quote.ts"))
      .StakeQuoteResponseSchema,
};

// Called ONLY when the caller has already confirmed
// env.METAGRAPH_VALIDATE_RESPONSES === "true" -- see this file's own header.
export async function validateResponseTripwire(
  routeId: string,
  envelope: unknown,
): Promise<void> {
  const loadSchema = SCHEMA_LOADERS[routeId];
  if (!loadSchema) return; // Route not yet covered by a schemas-src/ schema.
  try {
    const schema = await loadSchema();
    const result = schema.safeParse(envelope);
    if (!result.success) {
      console.warn(
        `[METAGRAPH_VALIDATE_RESPONSES] ${routeId} response drifted from its Zod schema:`,
        result.error,
      );
    }
  } catch (err) {
    // The tripwire itself must never break a real response.
    console.warn(
      `[METAGRAPH_VALIDATE_RESPONSES] ${routeId} tripwire failed to run:`,
      err,
    );
  }
}
