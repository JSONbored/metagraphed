// A published query parameter states the vocabulary's constraint, not its own
// copy of it (#10073).
//
// `schemas-src/query-params.ts` holds one definition per parameter. Before this
// gate, `src/contracts.ts` held a SECOND set as raw JSON literals, and the two
// disagreed: measured across the published openapi.json against the emitted MCP
// `inputSchema`s, 290 of 658 shared argument pairs differed. Not 290 separate
// mistakes -- two vocabularies, drifting the way two copies of one fact always
// do. `netuid` was bounded on one surface and unbounded on the other, `fields`
// carried two different regexes, `q` a ceiling on one side only.
//
// This is the same shape as validate-single-schema-source (#9830): the fix was
// to delete the second source, and the gate is what stops it growing back.
//
// ## Why only these three
//
// A parameter belongs here when it has exactly ONE correct constraint
// everywhere it appears:
//
//   netuid  a u16 on chain, on every route that takes one
//   fields  every route resolves it through the same parseFieldsParam
//   order   asc | desc, on all 38 routes that publish it
//
// `limit`, `cursor`, `offset` and `q` are deliberately NOT here: their ceilings
// are per-route by design and live in `src/route-limits.ts` (a validator
// directory serving 2000 rows and a leaderboard serving 100 are both correct).
// A gate that demanded one value for those would be demanding the wrong thing.
//
// Compared against the EMITTED openapi.json rather than the source, because
// that is the document a client generates from -- the same reason
// validate-mcp-input-parity reads the emitted inputSchema.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  fieldsSchema,
  netuidSchema,
  orderSchema,
} from "../schemas-src/query-params.ts";
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";

type Row = Record<string, unknown>;

/**
 * The parameters with exactly one correct constraint, and the builder that owns
 * it. Adding an entry here is a claim that every route means the same thing by
 * that name -- check before adding one.
 */
const VOCABULARY: Record<string, z.ZodType> = {
  netuid: netuidSchema(),
  fields: fieldsSchema(),
  order: orderSchema(),
};

/**
 * Standing debt: `route ?parameter` -> why it does not yet state the bound.
 *
 * Same contract as validate-mcp-input-parity's DECLARED -- every entry is a
 * decision somebody made, and a STALE entry FAILS, so the list can only shrink
 * or stay honest.
 */
const NOT_YET_ENFORCED =
  "the route publishes `netuid` but does not reject an out-of-u16 value -- " +
  "it answers 200 with an empty result. Publishing the bound before enforcing " +
  "it would move the lie rather than fix it; see #10075";

const DECLARED: Record<string, string> = {
  "/api/v1/accounts/{ss58}/events ?netuid": NOT_YET_ENFORCED,
  "/api/v1/accounts/{ss58}/history ?netuid": NOT_YET_ENFORCED,
  "/api/v1/chain/emission-pipeline ?netuid": NOT_YET_ENFORCED,
  "/api/v1/compare/validators ?netuid": NOT_YET_ENFORCED,
};

/**
 * Key order differs between the two producers -- openapi.json is written
 * sorted, Zod emits in declaration order -- so compare canonically. Comparing
 * raw JSON.stringify reports every parameter as divergent, which reads as a
 * catastrophic failure rather than as a bug in the comparison.
 */
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

/**
 * The builder's CONSTRAINTS as a published parameter carries them: no
 * `$schema` (per-document metadata), and no `description`/`examples` (the
 * builder's MCP-audience prose, which the REST surface replaces with its own
 * from SHARED_QUERY_PARAMETER_DESCRIPTIONS).
 */
function publishedForm(schema: z.ZodType): string {
  const emitted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  const {
    $schema: _schema,
    description: _description,
    examples: _examples,
    ...rest
  } = emitted;
  return canonical(stripSentinelIntegerBounds(rest));
}

const expected = new Map(
  Object.entries(VOCABULARY).map(([name, schema]) => [
    name,
    publishedForm(schema),
  ]),
);

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as Row;

const errors: string[] = [];
const used = new Set<string>();
let compared = 0;
let aligned = 0;

for (const [route, operations] of Object.entries(
  (openapi.paths ?? {}) as Record<string, Row>,
)) {
  for (const operation of Object.values(operations)) {
    for (const parameter of ((operation as Row)?.parameters ?? []) as Row[]) {
      if (parameter.in !== "query") continue;
      const name = String(parameter.name);
      const want = expected.get(name);
      if (want === undefined) continue;
      compared += 1;
      if (canonical(parameter.schema) === want) {
        aligned += 1;
        continue;
      }
      const key = `${route} ?${name}`;
      if (DECLARED[key]) {
        used.add(key);
        continue;
      }
      errors.push(
        `${key} publishes ${canonical(parameter.schema)}, but the vocabulary ` +
          `defines ${want}.\n` +
          `  Build it from ${name}Schema() in schemas-src/query-params.ts, or ` +
          `add "${key}" to DECLARED with the reason it differs.`,
      );
    }
  }
}

const stale = Object.keys(DECLARED)
  .filter((key) => !used.has(key))
  .sort();
if (stale.length > 0) {
  errors.push(
    `${stale.length} DECLARED entr(y/ies) no longer describe a divergence — delete them:\n` +
      stale.map((key) => `    ${key}`).join("\n"),
  );
}

if (errors.length > 0) {
  console.error(
    `Query-vocabulary validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

// A comparison that silently matched nothing is the failure mode this guards
// against: it would pass forever the moment a rename broke the lookup.
assert.ok(
  compared > 0,
  "no published parameter matched a vocabulary name — the comparison found nothing to check",
);
console.log(
  `Query-vocabulary validation passed: ${compared} published parameter(s) across ` +
    `${expected.size} shared name(s), ${aligned} built from the vocabulary, ` +
    `${Object.keys(DECLARED).length} declared divergence(s).`,
);
