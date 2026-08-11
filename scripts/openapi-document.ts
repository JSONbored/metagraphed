// Which component does a route's `data` carry? Ask the source, not the artifact.
//
// Four scripts needed this answer and each had written its own walk over the
// generated `openapi.json` -- down `paths[route].get.responses["200"].content
// ["application/json"].schema.allOf[].properties.data.$ref`. Two of them also
// declared their own `OpenApiDocument` for the trip, structurally identical
// and unaware of each other.
//
//   scripts/check-graphql-int-range.ts            exported `dataComponent`
//   scripts/check-graphql-nullability.ts          exported `dataComponent`
//   scripts/validate-graphql-component-parity.ts  a private closure
//   scripts/validate-published-names.ts           a private closure
//
// None of them had to. That `$ref` is not an independent fact about the
// document -- `src/contracts.ts` COMPUTES it, in one line, from the route's
// own artifact path:
//
//     data: { $ref: `#/components/schemas/${schemaRefForArtifactPath(
//              entry.artifact_path)}` }
//
// So the walk was four hand-rolled re-derivations of a function that is
// exported. Reading them out of the emitted JSON meant the answer depended on
// the artifact being present, current, and shaped the way each copy assumed --
// and when an assumption broke, the walk returned `null` rather than throwing,
// which every caller reads as "this route names no component" and skips. A
// gate that skips is a gate that passes.
//
// `dataComponent` now takes the route and asks `API_ROUTES` +
// `schemaRefForArtifactPath` directly. Change the envelope shape and there is
// nothing here to update, because nothing here models the envelope.

/**
 * The part of `openapi.json` these readers touch.
 *
 * Deliberately narrow. A wider type would have to be maintained against the
 * generator by hand, which is the thing this file exists to stop.
 */
import {
  API_ROUTES,
  networkVariantPath,
  schemaRefForArtifactPath,
} from "../src/contracts.ts";

export interface OpenApiDocument {
  paths?: Record<
    string,
    {
      get?: {
        // `unknown[]`, and narrowed inside `limitFor` rather than declared.
        // The document is untyped JSON at runtime, and the looser spelling is
        // what `schemas-src/graphql/query-arguments.ts` already publishes for
        // the same array -- declaring a stricter one here would make the two
        // views of one document mutually unassignable, which is how a second
        // copy gets written instead of the first reused.
        parameters?: readonly unknown[];
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              {
                schema?: {
                  allOf?: { properties?: { data?: { $ref?: string } } }[];
                };
              }
            >;
          }
        >;
      };
    }
  >;
}

/**
 * Route template -> the component its `data` carries, built once.
 *
 * Both spellings, because the document publishes both: 42 routes also appear
 * network-scoped as `/api/v1/{network}/...`, and those twins are NOT their own
 * `API_ROUTES` entries -- the emitter derives them through
 * `networkVariantPath`, so this does too rather than re-deciding which routes
 * qualify. Building from `API_ROUTES` alone left all 42 answering null, which
 * the cross-check in tests/graphql-int-range.test.ts caught immediately: a
 * silent null is exactly the failure this module exists to remove, and it
 * reappeared the moment the derivation was incomplete.
 */
const COMPONENT_BY_ROUTE = new Map<string, string>();
for (const entry of API_ROUTES) {
  const component = schemaRefForArtifactPath(entry.artifact_path);
  COMPONENT_BY_ROUTE.set(entry.path, component);
  const scoped = networkVariantPath(entry.path);
  if (scoped) COMPONENT_BY_ROUTE.set(scoped, component);
}

/**
 * The component a route's `data` property refs, or null for a route the
 * contract does not define.
 *
 * Null means "no such route", which is a different answer from the old walk's
 * null ("the shape under this route was not what I expected"). The second was
 * indistinguishable from the first at the call site, so a drifted envelope
 * silently emptied every gate that asked.
 */
export function dataComponent(route: string): string | null {
  return COMPONENT_BY_ROUTE.get(route) ?? null;
}

/**
 * `limit=<the route's own maximum>`, or an empty string where it publishes no
 * such parameter.
 *
 * Read from the spec rather than guessed. The ceiling is per-route
 * (`schemas-src/route-queries.ts` single-sources it) and REST REJECTS both an
 * unknown parameter and an over-ceiling one -- MCP is the surface that clamps
 * -- so a blanket `?limit=100` turns a healthy route into a 400 and reports
 * the silence as coverage.
 */
export function limitFor(openapi: OpenApiDocument, route: string): string {
  for (const entry of openapi.paths?.[route]?.get?.parameters ?? []) {
    const parameter = entry as {
      name?: string;
      $ref?: string;
      schema?: { maximum?: number };
    };
    const name = parameter.name ?? parameter.$ref?.split("/").pop() ?? "";
    if (!name.toLowerCase().includes("limit")) continue;
    const maximum = parameter.schema?.maximum;
    return `limit=${typeof maximum === "number" ? maximum : 100}`;
  }
  return "";
}
