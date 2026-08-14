// "Did the caller ask for less?" — one answer, for both surfaces that validate
// what they serve.
//
// ## WHY THIS IS SHARED RATHER THAN ASKED TWICE
//
// A projected response is SHORTER than the schema that describes it, on
// purpose. `required` describes the unprojected document (#10960), so every
// response tripwire has to know whether a projection happened before it can
// call an absent key a drift.
//
// REST learned this in #10975: `?fields=name` returned 500 on six routes,
// because the component describes the whole row and the caller had asked for
// one column. #11079 added `include_points=false` to the same list for the same
// reason. Both fixes landed in workers/api.ts as a URL-parameter check, and the
// MCP dispatch — which accepts the SAME three levers as tool ARGUMENTS — never
// got either. Measured 2026-08-14: `get_subnet(netuid=105,
// sections="health,counts,curation,gaps")` failed with `response_schema_drift`
// on `netuid`, a key the caller had deliberately not selected, on a response
// that was exactly what was asked for. The REST route serving the same
// projection answered 200.
//
// So the two seams disagreed about one contract, which is the thing the
// zero-drift epic exists to stop. The vocabulary lives here, once, and both
// callers derive from it: a fourth lever added tomorrow reaches both surfaces
// or neither.
//
// ## WHAT A PROJECTION IS ALLOWED TO DO
//
// Remove keys. That is all. It cannot add one and it cannot change a type, so
// `isProjectedAway` forgives ABSENCE and only at the issue's own path — an
// unrecognized key or a present value of the wrong type still fails, on both
// surfaces. Those are the two things a caller would actually be hurt by.

/**
 * The parameters that make a response smaller by request.
 *
 * `fields` picks columns out of the rows of a list; `sections` picks whole
 * cards out of one composite document (#10600). They are different units of
 * selection and deliberately different names, but they have the same
 * consequence for a response validator.
 */
export const PROJECTION_PARAMETERS = ["fields", "sections"] as const;

/**
 * The third lever, which is not a parameter name but a value.
 *
 * `include_points=false` omits `data.points` BY REQUEST (#9720). It is spelled
 * out rather than folded into the list above because only the literal `false`
 * projects — any other value either defaults to true or is refused before a
 * response exists to validate.
 */
export const PROJECTION_TOGGLE = "include_points" as const;

/** REST's signal: the request URL carried a projecting parameter. */
export function urlProjects(params: URLSearchParams): boolean {
  return (
    PROJECTION_PARAMETERS.some((name) => params.has(name)) ||
    params.get(PROJECTION_TOGGLE) === "false"
  );
}

/**
 * MCP's signal: the tool call carried a projecting argument.
 *
 * An EMPTY string does not project — `fields: ""` selects nothing and the
 * parsers refuse it upstream, so treating it as a projection here would forgive
 * absence on a call that never narrowed anything. `include_points` arrives as a
 * real boolean over MCP rather than the string REST parses.
 */
export function argsProject(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  for (const name of PROJECTION_PARAMETERS) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return record[PROJECTION_TOGGLE] === false;
}

/**
 * Is this validation issue just a key the projection removed?
 *
 * Resolved by walking the path into the payload rather than matching on the
 * issue's message, because a message is prose and this is a gate. `undefined`
 * at the issue's own path means the value is genuinely absent; anything else
 * present means the issue is about something the projection did not do.
 *
 * EXPORTED for its own test. The mid-path guard cannot be reached through a
 * real Zod issue -- Zod reports at the level that failed and never emits a path
 * descending THROUGH a scalar -- so the only way to prove it fires is to hand it
 * such a path directly. Testing it beats suppressing it: this is the one place
 * either tripwire can forgive a real drift, which it must never do.
 */
export function isProjectedAway(
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
