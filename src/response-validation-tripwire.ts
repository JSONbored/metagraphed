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
 * The envelope AS THE CLIENT RECEIVES IT, not as the handler built it.
 *
 * Same reasoning as the MCP tripwire's own copy of this (#10972), and the same
 * one-line change, made here even though REST does not currently trip on it:
 * an artifact composed from an absent source leaves keys present with
 * `undefined` (`overlaySubnetHealth(null, ...)` produces four), Zod
 * `.strict()` counts those as unrecognized, and `JSON.stringify` drops them
 * before the client sees anything.
 *
 * REST escapes it today only because the components involved happen to declare
 * those fields optional. That is a property of which fields drifted first, not
 * a difference in kind -- the next strict component that omits a key some
 * composer leaves undefined would fail a response that serializes correctly,
 * exactly as `get_subnet_health` did on 46% of its calls.
 *
 * NOT shared with the MCP copy: this module is imported by the Worker entry
 * and that one by the MCP dispatch, and a shared import for eight lines would
 * couple two tripwires that are deliberately independent (see this file's
 * header on why they are one decision but not one implementation).
 */
function asSentOverTheWire(payload: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return payload;
  }
}

/**
 * Is this issue just a field the projection removed?
 *
 * ## WHY A PROJECTION NEEDS ITS OWN ANSWER
 *
 * `?fields=` returns FEWER keys on purpose, and the component describes the
 * whole row -- so every projected response failed, on every route that
 * advertises the parameter (#10975). Measured against production: `?fields=name`
 * returned 500 on gaps, curation, candidates, profiles, subnets and providers.
 * Selecting fewer fields is the entire point of the parameter and it was the
 * thing that broke it.
 *
 * ## WHAT IS STILL ENFORCED
 *
 * Only ABSENCE is forgiven, and only when the value at the issue's own path is
 * genuinely missing. A projection can remove a key; it cannot add one and it
 * cannot change a type. So an unrecognized key still fails, and a present value
 * of the wrong type still fails -- the two things a caller would actually be
 * hurt by.
 *
 * Resolved by walking the path into the payload rather than matching on the
 * issue's message, because a message is prose and this is a gate.
 */
function isProjectedAway(
  payload: unknown,
  path: readonly PropertyKey[],
): boolean {
  let node: unknown = payload;
  for (const key of path) {
    if (node == null || typeof node !== "object") return false;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node === undefined;
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
  /**
   * True when the caller asked for a subset of fields. A projected response is
   * SHORTER than its component by design, so absence stops being a drift --
   * see `isProjectedAway` for what stays enforced.
   */
  projected = false,
): Promise<void> {
  if (!artifactPath) return;
  try {
    const schema = await schemaForArtifact(artifactPath);
    if (!schema) return;
    const wire = asSentOverTheWire(envelope);
    const result = schema.safeParse(wire);
    if (!result.success) {
      const issues = projected
        ? result.error.issues.filter(
            (issue) => !isProjectedAway(wire, issue.path),
          )
        : result.error.issues;
      // Every issue explained by the projection means the response is exactly
      // what was asked for. Anything left is a real drift and still throws.
      if (issues.length > 0) {
        throw new ResponseSchemaDriftError(routeId, {
          ...result.error,
          issues,
        });
      }
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
