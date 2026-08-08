// Every route's Zod query schema emits exactly what that route publishes (#10062).
//
// `schemas-src/route-queries.ts` and `listQuerySchema()` are about to become
// the source the published parameters are generated FROM (3/5, #10063). This
// gate is what makes that flip provable rather than hopeful: if the two sides
// agree today, moving the source of truth cannot change `openapi.json`.
//
// It also stops the drift returning. Before #10062 the same parameter was
// stated in up to four places, and the copy in `schemas-src/routes/` -- which
// nothing imported -- disagreed with the published one on 51 of the 88 routes
// that had one. Nothing reported it, because no check ever compared them.
//
// ## Compared on EMITTED JSON, canonically
//
// Zod source and a published parameter cannot be compared as text. Both sides
// go through `z.toJSONSchema(..., { io: "input" })` and a canonical key sort:
// `openapi.json` is written with sorted keys while Zod emits in declaration
// order, so a raw compare reports every parameter as divergent and reads as
// catastrophic failure rather than as a bug in the comparison.
//
// `description` and `examples` are stripped. This gate is about CONSTRAINTS --
// what the server will accept. A parameter's prose is per-route and still
// lives with the route; unifying it is a separate judgement, deliberately not
// smuggled in here.
//
// `z.int()` always stamps `maximum: 9007199254740991`. That is a safe-integer
// sentinel rather than a bound anyone declared, and both published surfaces
// drop it, so `stripSentinelIntegerBounds` drops it here too.
//
// ## Every route is classified, or this fails
//
// A route resolving to no schema is a FAILURE, not a route that takes no
// parameters -- `NO_QUERY_PARAMETERS` is how "takes none" is said. The failure
// mode of a schema comparison is silence, so the floor counts below exist to
// make a sweep that stopped covering the surface loud.
import assert from "node:assert/strict";
import { z } from "zod";
import { API_ROUTES, querySchemaForRoute } from "../src/contracts.ts";
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Row;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** One parameter's constraints, as both sides express them. */
function constraints(schema: Row): string {
  const {
    $schema: _schema,
    description: _description,
    examples: _examples,
    ...rest
  } = schema;
  return canonical(stripSentinelIntegerBounds(rest));
}

/** Each property of a Zod object, rendered the way a published parameter is. */
function emittedProperties(schema: z.ZodObject): Map<string, string> {
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  const out = new Map<string, string>();
  for (const [name, property] of Object.entries(
    (document.properties ?? {}) as Record<string, Row>,
  )) {
    out.set(name, constraints(property));
  }
  return out;
}

const routes = API_ROUTES as unknown as {
  path: string;
  method: string;
  query_collection?: string | null;
  query_filter_names?: string[];
  csv_response?: boolean;
  query_parameters?: { name: string; schema: Row }[];
}[];

const unclassified: string[] = [];
const mismatches: string[] = [];
let comparedRoutes = 0;
let comparedParameters = 0;
let collectionRoutes = 0;
let declaredRoutes = 0;

for (const route of routes) {
  const schema = querySchemaForRoute(route);
  if (!schema) {
    unclassified.push(`${route.method} ${route.path}`);
    continue;
  }
  if (route.query_collection) collectionRoutes++;
  else declaredRoutes++;
  comparedRoutes++;

  const emitted = emittedProperties(schema);
  const published = new Map(
    (route.query_parameters ?? []).map((parameter) => [
      parameter.name,
      constraints(parameter.schema),
    ]),
  );

  const emittedNames = [...emitted.keys()].sort();
  const publishedNames = [...published.keys()].sort();
  if (emittedNames.join(",") !== publishedNames.join(",")) {
    const extra = emittedNames.filter((name) => !published.has(name));
    const missing = publishedNames.filter((name) => !emitted.has(name));
    mismatches.push(
      `${route.path}: parameter NAMES differ` +
        (missing.length
          ? `\n    schema is MISSING: ${missing.join(", ")}`
          : "") +
        (extra.length ? `\n    schema has EXTRA:  ${extra.join(", ")}` : ""),
    );
    continue;
  }

  for (const [name, want] of published) {
    comparedParameters++;
    const got = emitted.get(name);
    if (got !== want) {
      mismatches.push(
        `${route.path} ?${name}: constraints differ` +
          `\n    route:  ${want}` +
          `\n    schema: ${got}`,
      );
    }
  }
}

assert.deepEqual(
  unclassified,
  [],
  "these routes resolve to no query schema at all -- add them to " +
    "ROUTE_QUERY_SCHEMAS, or to NO_QUERY_PARAMETERS if they genuinely accept " +
    `none:\n  ${unclassified.join("\n  ")}`,
);

assert.deepEqual(
  mismatches,
  [],
  "these routes publish something their Zod query schema does not say, so " +
    "3/5 could not emit the published parameters from it without changing " +
    `openapi.json:\n  ${mismatches.join("\n  ")}`,
);

// ---- the sweep is not vacuous ---------------------------------------------
//
// Every assertion above passes on an empty comparison. These floors are the
// counts measured when the gate was written; they may only be raised.
assert.ok(
  comparedRoutes >= 203,
  `only ${comparedRoutes} routes were compared; the gate stopped covering the surface`,
);
assert.ok(
  collectionRoutes >= 34,
  `only ${collectionRoutes} collection routes resolved through listQuerySchema()`,
);
assert.ok(
  declaredRoutes >= 169,
  `only ${declaredRoutes} routes resolved through ROUTE_QUERY_SCHEMAS/NO_QUERY_PARAMETERS`,
);
assert.ok(
  comparedParameters >= 678,
  `only ${comparedParameters} parameters were compared; the published set shrank`,
);

console.log(
  `route-query parity: ${comparedRoutes} routes ` +
    `(${collectionRoutes} generated from a collection, ${declaredRoutes} declared), ` +
    `${comparedParameters} parameters, 0 divergences.`,
);
