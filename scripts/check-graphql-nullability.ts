// Is the GENERATED schema's nullability true of production? (#10214)
//
// The emitter marks a field non-null when its Zod has no `.nullable()`. That is
// a claim about the schema; graphql-js turns it into a promise about the
// PRODUCER, enforced at execution -- one null and the whole surrounding object
// nulls with an error attached, which is what `SelfHealthLane.detail` did on
// every self_health request (#10215).
//
// 253 fields differ that way between the generated schema and the served one,
// and the served one is the safe side of every difference. Cutting over means
// making 253 promises at once, so each needs evidence, and the only place that
// evidence exists is the live surface.
//
// THIS IS THE EVIDENCE. For every Query field, it builds a selection from the
// GENERATED type -- every non-null leaf it can reach that the PUBLISHED schema
// also exposes -- sends it to production, and walks the answer against the
// generated type. A null under a generated non-null is reported with the query
// that found it, so the fix is either the Zod (the producer really can answer
// null) or nothing (the field is safe to tighten).
//
// Out of band, like its conformance siblings: a check that needs production
// data should not pretend to run on a pull request.
//
// The complement of `src/response-validation-tripwire.ts`, which does the same
// job continuously for REST. Together they are what makes the cutover a
// measurement rather than a leap: REST proves the components hold on every
// request, this proves the GraphQL-only promises hold on the live surface.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  buildSchema,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql";
import type {
  GraphQLField,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
} from "graphql";
import { buildGeneratedSchema } from "../schemas-src/graphql/build-schema.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";
import { SDL } from "../src/graphql-sdl.ts";

const BASE = process.env.CONFORMANCE_API_BASE || "https://api.metagraph.sh";
const SPEC_PATH =
  process.env.CONFORMANCE_SPEC_PATH || "public/metagraph/openapi.json";
/** How deep to follow object edges when building a probe selection. */
const MAX_DEPTH = 3;

/** Known-good values for the arguments a Query field requires. */
const ARGUMENTS: Readonly<Record<string, string>> = {
  netuid: "1",
  hotkey: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  coldkey: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  ss58: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  address: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  account: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  slug: '"apex"',
  tag: '"inference"',
  netuids: "[1, 2]",
  hotkeys: '["5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"]',
  ref: '"8813000"',
  block: "8813000",
  block_number: "8813000",
  id: '"1"',
  name: '"subnets"',
  path: '"/metagraph/subnets.json"',
  amount: "1.0",
};

export interface NullabilityFinding {
  /** `Type.field`, as the generated schema names it. */
  field: string;
  /** How many of the sampled values were null. */
  nulls: number;
  seen: number;
  /** The Query field(s) whose answer exposed it -- how to reproduce. */
  via: string;
}

export interface NullabilityReport {
  /** Query fields the probe could build and send. */
  probed: number;
  /** Query fields skipped, with the reason. */
  skipped: string[];
  /** Non-null leaves observed at least once. */
  observed: number;
  /** Generated non-nulls production actually answered null for. */
  findings: NullabilityFinding[];
  /** Non-null leaves the probe never saw a value for. */
  unobserved: string[];
}

/** The published schema's counterpart of a generated type, if it has one. */
function publishedType(
  published: GraphQLSchema,
  type: GraphQLNamedType,
): GraphQLObjectType | null {
  const counterpart = published.getType(type.name);
  return isObjectType(counterpart) ? counterpart : null;
}

/**
 * A selection covering every non-null leaf the generated type promises, kept to
 * what the PUBLISHED schema also exposes -- production serves that one, so a
 * field only the generator has cannot be asked for.
 *
 * Returns null when nothing is selectable, which is not a finding: a type whose
 * every field is an object the published schema lacks simply cannot be probed
 * from here.
 */
function selectionFor(
  generated: GraphQLObjectType,
  published: GraphQLSchema,
  depth: number,
  seen: ReadonlySet<string>,
): { text: string; leaves: string[] } | null {
  const counterpart = publishedType(published, generated);
  if (!counterpart) return null;
  const parts: string[] = [];
  const leaves: string[] = [];
  for (const [name, field] of Object.entries(generated.getFields())) {
    if (!counterpart.getFields()[name]) continue;
    const named = getNamedType(field.type);
    if (isScalarType(named) || isEnumType(named)) {
      parts.push(name);
      if (isNonNullType(field.type)) leaves.push(`${generated.name}.${name}`);
      continue;
    }
    if (!isObjectType(named) || depth >= MAX_DEPTH || seen.has(named.name)) {
      continue;
    }
    const nested = selectionFor(
      named,
      published,
      depth + 1,
      new Set([...seen, named.name]),
    );
    if (!nested) continue;
    parts.push(`${name} ${nested.text}`);
    leaves.push(...nested.leaves);
    if (isNonNullType(field.type)) leaves.push(`${generated.name}.${name}`);
  }
  if (!parts.length) return null;
  return { text: `{ ${parts.join(" ")} }`, leaves };
}

/** The arguments a Query field requires, rendered -- or null if one is unknown. */
function renderArguments(field: GraphQLField<unknown, unknown>): string | null {
  const parts: string[] = [];
  for (const argument of field.args) {
    if (!isNonNullType(argument.type)) continue;
    const value = ARGUMENTS[argument.name];
    if (value === undefined) return null;
    parts.push(`${argument.name}: ${value}`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

/**
 * Walk an answer beside BOTH types, counting nulls the generated schema would
 * forbid.
 *
 * The answer is shaped by the PUBLISHED schema -- that is what production
 * serves -- so the published type is what describes it, and walking it as the
 * generated type instead invents findings wherever the two disagree. The first
 * version of this did exactly that: `incidents` returns `IncidentList` in the
 * generated schema and `GlobalIncidents` in the served one, and reading the
 * answer through the wrong type reported 18 `EndpointIncident` fields as null
 * on 232 rows for a path production does not expose at all.
 *
 * So: the published type drives the walk, and a field is only judged when the
 * generated type has it too.
 */
function walk(
  value: unknown,
  publishedOn: GraphQLOutputType,
  generatedOn: GraphQLOutputType | null,
  path: string,
  counts: Map<string, { seen: number; nulls: number; via: Set<string> }>,
  via: string,
): void {
  const named = getNamedType(publishedOn);
  const generatedNamed = generatedOn ? getNamedType(generatedOn) : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, named, generatedNamed, path, counts, via);
    }
    return;
  }
  if (!isObjectType(named) || value === null || typeof value !== "object") {
    return;
  }
  // Only a generated type of the SAME NAME describes this answer. A different
  // one is a type disagreement between the two schemas, which the schema diff
  // reports -- not a nullability fact about the producer.
  const generatedType =
    generatedNamed &&
    isObjectType(generatedNamed) &&
    generatedNamed.name === named.name
      ? generatedNamed
      : null;
  const row = value as Record<string, unknown>;
  for (const [name, field] of Object.entries(named.getFields())) {
    if (!(name in row)) continue;
    const generatedField = generatedType?.getFields()[name];
    if (generatedField && isNonNullType(generatedField.type)) {
      const key = `${named.name}.${name}`;
      const bucket = counts.get(key) ?? { seen: 0, nulls: 0, via: new Set() };
      bucket.seen += 1;
      if (row[name] === null) {
        bucket.nulls += 1;
        bucket.via.add(via);
      }
      counts.set(key, bucket);
    }
    walk(
      row[name],
      field.type,
      generatedField?.type ?? null,
      `${path}.${name}`,
      counts,
      via,
    );
  }
}

export async function checkNullability(
  openapi: OpenApiParameters,
  fetchImpl: typeof fetch = fetch,
): Promise<NullabilityReport> {
  const { schema: generated } = buildGeneratedSchema(openapi);
  const published = buildSchema(SDL);
  const root = generated.getQueryType()!;
  const counts = new Map<
    string,
    { seen: number; nulls: number; via: Set<string> }
  >();
  const skipped: string[] = [];
  const allLeaves = new Set<string>();
  let probed = 0;

  for (const binding of QUERY_BINDINGS) {
    const field = root.getFields()[binding.field];
    if (!field) {
      skipped.push(`${binding.field} -- the generated root has no such field`);
      continue;
    }
    const args = renderArguments(field);
    if (args === null) {
      skipped.push(
        `${binding.field} -- a required argument has no known value`,
      );
      continue;
    }
    const named = getNamedType(field.type);
    if (!isObjectType(named)) {
      skipped.push(`${binding.field} -- returns a leaf, nothing to walk`);
      continue;
    }
    const selection = selectionFor(named, published, 1, new Set([named.name]));
    if (!selection) {
      skipped.push(
        `${binding.field} -- nothing selectable on the served schema`,
      );
      continue;
    }
    for (const leaf of selection.leaves) allLeaves.add(leaf);
    const query = `{ ${binding.field}${args} ${selection.text} }`;
    let body: { data?: unknown; errors?: { message: string }[] };
    try {
      const response = await fetchImpl(`${BASE}/api/v1/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      body = (await response.json()) as typeof body;
    } catch (error) {
      skipped.push(`${binding.field} -- ${String(error)}`);
      continue;
    }
    if (body.errors?.length) {
      skipped.push(
        `${binding.field} -- ${body.errors
          .map((e) => e.message)
          .join(" | ")
          .slice(0, 120)}`,
      );
      continue;
    }
    probed += 1;
    const answer = (body.data as Record<string, unknown> | undefined)?.[
      binding.field
    ];
    const publishedField = published.getQueryType()?.getFields()[binding.field];
    walk(
      answer,
      publishedField!.type,
      field.type,
      binding.field,
      counts,
      binding.field,
    );
  }

  const findings: NullabilityFinding[] = [];
  for (const [key, bucket] of counts) {
    if (bucket.nulls) {
      findings.push({
        field: key,
        nulls: bucket.nulls,
        seen: bucket.seen,
        via: [...bucket.via].sort().join(", "),
      });
    }
  }
  return {
    probed,
    skipped,
    observed: [...counts.values()].filter((c) => c.seen > 0).length,
    findings: findings.sort((a, b) => a.field.localeCompare(b.field)),
    unobserved: [...allLeaves].filter((leaf) => !counts.get(leaf)?.seen).sort(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkNullability(
    JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiParameters,
  );
  console.log(
    `graphql-nullability: probed ${report.probed} Query field(s) against ${BASE}; ` +
      `${report.observed} generated non-null field(s) observed, ` +
      `${report.findings.length} answered NULL.`,
  );
  if (report.unobserved.length) {
    console.log(
      `\n${report.unobserved.length} non-null field(s) the probe never saw a value for -- ` +
        `no evidence either way:`,
    );
    for (const line of report.unobserved.slice(0, 30))
      console.log(`  - ${line}`);
    if (report.unobserved.length > 30) {
      console.log(`  … and ${report.unobserved.length - 30} more`);
    }
  }
  if (report.skipped.length) {
    console.log(`\n${report.skipped.length} Query field(s) skipped:`);
    for (const line of report.skipped.slice(0, 20)) console.log(`  - ${line}`);
    if (report.skipped.length > 20) {
      console.log(`  … and ${report.skipped.length - 20} more`);
    }
  }
  if (report.findings.length) {
    console.log(
      `\n${report.findings.length} field(s) the generated schema promises non-null ` +
        `and production answers NULL -- each is a Zod that overstates its producer:`,
    );
    for (const finding of report.findings) {
      console.log(
        `  - ${finding.field} -- null on ${finding.nulls} of ${finding.seen} ` +
          `sampled, via ${finding.via}`,
      );
    }
    process.exit(1);
  }
}
