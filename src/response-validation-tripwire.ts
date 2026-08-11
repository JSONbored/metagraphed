// Parse every outgoing REST envelope against the Zod schema that defines it.
//
// This shipped in #7860 as a five-route pilot: `SCHEMA_LOADERS` hand-listed
// `subnets`, `subnet-detail`, `health`, `economics` and `subnet-stake-quote`,
// with a comment saying to add an entry as later batches converted more routes.
// The batches landed and the entries did not, so 156 of 161 routes served
// unchecked -- and the flag was `"false"` in wrangler.jsonc, so the five did
// too.
//
// It is DERIVED now, and covers everything by construction. A route names its
// artifact; `schemaRefForArtifactPath` maps that to the component id the
// OpenAPI document publishes; `COMPONENT_SCHEMAS_BY_ID` gives back the Zod node
// `register()` recorded under that id. There is no list to fall behind: a route
// converted tomorrow is covered the moment its component is registered, which
// is the same moment it appears in `openapi.json`.
//
// WHY IT MATTERS BEYOND DRIFT. The published GraphQL schema takes its
// nullability from these components, and `graphql-js` enforces non-null at
// EXECUTION -- one null where a component says non-null and the whole
// surrounding object nulls with an error attached (#10215). Until this ran,
// "the Zod says non-null" was a claim about the schema with nothing checking it
// against the producer. A sweep of the served surface found exactly one
// disagreement (`endpoint_pools.source`, fixed at the Zod); this is what keeps
// it at one.
//
// It THROWS. A drifted response is a response the published contract does not
// describe, and serving it anyway is how a consumer ends up trusting a shape
// nothing guarantees -- which is the entire failure this epic exists to close.
// That means it CANNOT run under `waitUntil`: the response is already built by
// then and a throw would only surface as an unhandled rejection. It is awaited
// in the response path, and the caller turns a drift into a 500 rather than
// serving the body.
//
// The cost is real and deliberate: when the flag is on, every response is
// parsed before it is sent, and a schema bug fails the route instead of
// quietly shipping. That is the trade the flag exists to make.
import { successEnvelopeSchema } from "../schemas-src/envelope.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import type { z } from "zod";

/** A response that does not match the schema its route publishes. */
export class ResponseSchemaDriftError extends Error {
  readonly routeId: string;
  readonly detail: unknown;
  constructor(routeId: string, detail: unknown) {
    super(`${routeId} response drifted from its Zod schema`);
    this.name = "ResponseSchemaDriftError";
    this.routeId = routeId;
    this.detail = detail;
  }
}

/** Resolved schemas, so a hot route pays the lookup once per isolate. */
/** The composed envelope schema per artifact path -- Zod's own type, so
 * `safeParse` narrows here rather than being re-declared at the call site. */
const cache = new Map<string, z.ZodType>();

/** Artifact paths with no component -- reported once, never re-resolved. */
const unresolved = new Set<string>();

// Both caches are per-isolate memoization, and `unresolved` also gates a
// warn-once. Under `isolate: false` that would carry across test files, so a
// suite that asserted the warning would pass or fail on which file ran first.
registerModuleStateReset("src/response-validation-tripwire.ts", () => {
  cache.clear();
  unresolved.clear();
});

async function schemaForArtifact(artifactPath: string) {
  const cached = cache.get(artifactPath);
  if (cached) return cached;
  if (unresolved.has(artifactPath)) return null;
  const [{ schemaRefForArtifactPath }, { COMPONENT_SCHEMAS_BY_ID }] =
    await Promise.all([
      import("./contracts.ts"),
      import("../schemas-src/openapi-registry.ts"),
    ]);
  let componentId: string;
  try {
    componentId = schemaRefForArtifactPath(artifactPath);
  } catch {
    // A route whose artifact has no contract entry. Not this module's problem
    // to fail on -- validate:openapi already owns that invariant.
    unresolved.add(artifactPath);
    return null;
  }
  const component = COMPONENT_SCHEMAS_BY_ID.get(componentId);
  if (!component) {
    unresolved.add(artifactPath);
    console.warn(
      `[METAGRAPH_VALIDATE_RESPONSES] ${artifactPath} maps to component ` +
        `${componentId}, which nothing registers -- not validated`,
    );
    return null;
  }
  const schema = successEnvelopeSchema(component);
  cache.set(artifactPath, schema);
  return schema;
}

/**
 * Called ONLY when the caller has already confirmed
 * `env.METAGRAPH_VALIDATE_RESPONSES === "true"` -- see this file's own header
 * and the call sites in workers/api.ts and workers/request-handlers/entities.ts.
 */
export async function validateResponseTripwire(
  routeId: string,
  envelope: unknown,
  artifactPath?: string,
): Promise<void> {
  if (!artifactPath) return;
  try {
    const schema = await schemaForArtifact(artifactPath);
    if (!schema) return;
    const result = schema.safeParse(envelope);
    if (!result.success) {
      throw new ResponseSchemaDriftError(routeId, result.error);
    }
  } catch (err) {
    // A DRIFT propagates -- that is the point. Anything else (a failed import,
    // a bad contract entry) is the tripwire's own fault and must not take a
    // route down with it.
    if (err instanceof ResponseSchemaDriftError) throw err;
    console.warn(
      `[METAGRAPH_VALIDATE_RESPONSES] ${routeId} tripwire failed to run:`,
      err,
    );
  }
}
