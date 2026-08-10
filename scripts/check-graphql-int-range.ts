// Does any field GraphQL publishes as `Int` carry a value Int cannot hold?
// (#10386)
//
// GraphQL's `Int` is 32-bit signed. An epoch-millisecond value is ~1.79e12, so
// a non-null `Int` field holding one raises on EVERY request and, because the
// error propagates, nulls the whole surrounding object -- the #10215 class,
// which `EndpointIncidentWindow.started_at` shipped with until someone read
// the SDL and noticed.
//
// WHY NO STATIC GATE CAN SEE THIS. `z.int()` stamps the JS safe-integer
// ceiling on every integer, count and instant alike, so "the declared maximum
// exceeds Int32" is true of all ~1,100 of them and says nothing. The published
// contract is equally blind: `check-response-conformance` validates against
// `openapi.json`, where `{type: "integer", maximum: 9007199254740991}` accepts
// 1786323600000 happily. And `validate:graphql-component-parity` deliberately
// ALLOWS `Float`-over-`Int` as a widening, because 26 fields rely on it. The
// overflow belongs to GraphQL's scalar alone, and only the real values expose
// it.
//
// So this measures the real values. It walks each live response alongside the
// EMITTED GraphQL type for that component, so it knows exactly which scalar a
// leaf would be published as, and fails on any `Int` leaf beyond the range.
// Run against production out of band, like its conformance siblings: a check
// that needs production data should not pretend to run on a pull request.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from "graphql";
import type { GraphQLOutputType } from "graphql";
import { API_ROUTES } from "../src/contracts.ts";
import { emitTypes } from "../schemas-src/graphql/emit.ts";
import { apiRouteUrl } from "./smoke-live-api.ts";

const BASE = process.env.CONFORMANCE_API_BASE || "https://api.metagraph.sh";
const SPEC_PATH =
  process.env.CONFORMANCE_SPEC_PATH || "public/metagraph/openapi.json";

/** GraphQL's Int is a signed 32-bit integer (graphql-js GRAPHQL_MAX_INT). */
export const GRAPHQL_MAX_INT = 2147483647;

export interface Overflow {
  route: string;
  /** Dotted path into the response `data`, arrays written `[]`. */
  path: string;
  value: number;
  /** The component field that would be published as Int. */
  field: string;
}

/** Only the sliver of the OpenAPI document this script reads. */
export interface OpenApiDocument {
  paths?: Record<
    string,
    {
      get?: {
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

/** The component a route's `data` property refs, or null. */
export function dataComponent(
  openapi: OpenApiDocument,
  route: string,
): string | null {
  const schema =
    openapi.paths?.[route]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ]?.schema;
  for (const part of schema?.allOf ?? []) {
    const ref = part?.properties?.data?.$ref;
    if (typeof ref === "string")
      return ref.replace("#/components/schemas/", "");
  }
  return null;
}

/**
 * Walk a live response beside the GraphQL type that would publish it, and
 * report every numeric leaf typed `Int` whose value is out of range.
 *
 * Exported so a test can drive it with a synthetic payload: a gate that has
 * only ever run against a passing tree proves nothing.
 */
export function findOverflows(
  data: unknown,
  type: GraphQLOutputType,
  route: string,
  path = "",
  typePath = "",
): Overflow[] {
  let current: GraphQLOutputType = type;
  while (current instanceof GraphQLNonNull) current = current.ofType;

  if (current instanceof GraphQLList) {
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) =>
      findOverflows(item, current.ofType, route, `${path}[]`, typePath),
    );
  }

  if (current instanceof GraphQLObjectType) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const fields = current.getFields();
    const found: Overflow[] = [];
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      const field = fields[key];
      // A key the component does not publish is REST's business, not
      // GraphQL's -- it can never be selected, so it can never overflow.
      if (!field) continue;
      found.push(
        ...findOverflows(
          value,
          field.type,
          route,
          `${path}.${key}`,
          `${current.name}.${key}`,
        ),
      );
    }
    return found;
  }

  if (current !== GraphQLInt) return [];
  if (typeof data !== "number" || Math.abs(data) <= GRAPHQL_MAX_INT) return [];
  return [{ route, path: path || "(root)", value: data, field: typePath }];
}

async function main(): Promise<void> {
  const openapi = JSON.parse(
    readFileSync(SPEC_PATH, "utf8"),
  ) as OpenApiDocument;
  const { types } = emitTypes();
  const today = new Date().toISOString().slice(0, 10);

  const overflows: Overflow[] = [];
  let checked = 0;
  let skipped = 0;

  for (const route of API_ROUTES as unknown as {
    path: string;
    method: string;
  }[]) {
    if (route.method !== "GET") continue;
    const component = dataComponent(openapi, route.path);
    const type = component ? types.get(component) : null;
    if (!type) {
      skipped += 1; // no component, or one the emitter answers no type for
      continue;
    }

    let url: string;
    try {
      // The smoke runner's fixture substitutions, rather than a second set of
      // sample ids that could drift from it.
      url = apiRouteUrl(route.path, today);
    } catch {
      skipped += 1; // unsubstitutable placeholder (needs a discovered id)
      continue;
    }

    let body: { ok?: boolean; data?: unknown } | null;
    try {
      const response = await fetch(new URL(url, BASE), {
        signal: AbortSignal.timeout(30_000),
      });
      body = response.status === 200 ? await response.json() : null;
    } catch {
      skipped += 1; // network/timeout: not drift
      continue;
    }
    // A degraded tier answers a schema-stable EMPTY body and passes, correctly:
    // this measures the values that ARE served, not whether any were.
    if (!body?.ok) {
      skipped += 1;
      continue;
    }

    checked += 1;
    overflows.push(...findOverflows(body.data, type, route.path));

    // Paced under the anonymous rate limit (100 req / 60s per IP).
    if (checked % 20 === 0) await new Promise((r) => setTimeout(r, 15_000));
  }

  console.log(
    `graphql-int-range: ${checked} route(s) measured, ${skipped} skipped, ` +
      `${overflows.length} value(s) beyond GraphQL's Int.`,
  );

  if (overflows.length === 0) {
    console.log("graphql-int-range: OK");
    return;
  }

  // One line per distinct FIELD, not per value: `candles[].bucket_start`
  // overflows on all 1,371 candles and is one bug.
  const byField = new Map<string, { count: number; sample: Overflow }>();
  for (const overflow of overflows) {
    const entry = byField.get(overflow.field);
    if (entry) entry.count += 1;
    else byField.set(overflow.field, { count: 1, sample: overflow });
  }
  console.error(
    `\n${byField.size} field(s) publish a value GraphQL's 32-bit Int cannot hold:`,
  );
  for (const [field, { count, sample }] of byField) {
    console.error(
      `  - ${field} -- ${count} value(s), e.g. ${sample.value} at ` +
        `${sample.route}${sample.path}`,
    );
  }
  console.error(
    "\nA non-null Int field carrying one of these errors on every request and " +
      "nulls\nits whole surrounding object. Model the field with " +
      "`EpochMillisSchema` if it is an\ninstant, or declare the right scalar " +
      "for it in emit.ts's SCALAR_COMPONENTS.",
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
