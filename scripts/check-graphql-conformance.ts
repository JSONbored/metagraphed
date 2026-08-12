// Does the GraphQL surface ANSWER? (#10215)
//
// MCP has `conformance:mcp` -- 221 tools called against production, responses
// validated against their own published schemas, scheduled daily. REST has
// `check-response-conformance.ts`. GraphQL had neither: everything asserted
// about it was static, the SDL compared to `openapi.json` offline, and nothing
// had ever executed a query against production and looked at the answer.
//
// WHAT A STATIC GATE CANNOT SEE. Both shapes are valid and the schema is
// satisfied in every one of these:
//
//   a field that resolves to null           DomainSummary.emission_concentration
//                                           was declared Float against a 12-key
//                                           object, so graphql-js coerced it to
//                                           null on all 14 domains -- and the
//                                           SDL's own comment defined that null
//                                           as "the domain has no members"
//   a field that answers a confident zero   chain_transfers reported 0 while
//                                           its REST twin reported 2,859,197 in
//                                           the same second (#10246)
//   a resolver that throws                  nothing dispatched these fields
//
// THREE THINGS FAIL THIS CHECK, and they need no judgement to confirm:
//
//   1. `errors[]`            the field did not answer
//   2. a null top-level      the SDL says the field resolves to a card, and
//                            production returned nothing
//   3. a numeric disagreement with the REST route the field says it MIRRORS
//
// (3) IS DELIBERATELY NARROW. ~25 of the SDL's types are resolver-built
// pagination views rather than mirrors of an artifact, so diffing a GraphQL
// answer against a REST body wholesale is a category error that manufactures
// findings -- measured: an early sweep reported 161 "divergences", of which the
// real count was 3. What is compared instead is only a key present on BOTH
// sides whose value is a NUMBER on both sides. That is exactly the class
// #10246 was: same question, same second, two different totals.
//
// Scheduled out of band like its MCP sibling, never in CI: it needs production.
import { buildSchema } from "graphql";
import type {
  GraphQLArgument,
  GraphQLField,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
} from "graphql";
import { SDL } from "../generated/graphql/schema.ts";

// Live GraphQL payloads, read for reporting. Same `Row` precedent as
// scripts/check-mcp-conformance.ts: an unexpected shape is what this exists to
// surface, so typing each hop through `unknown` buys nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ENDPOINT =
  process.env.GRAPHQL_CONFORMANCE_ENDPOINT ||
  "https://api.metagraph.sh/api/v1/graphql";
const REST_ORIGIN =
  process.env.GRAPHQL_CONFORMANCE_REST_ORIGIN || "https://api.metagraph.sh";
// Serial and spaced, for the reason the MCP sweep records: the endpoint
// rate-limits per CLIENT, so a parallel sweep turns healthy fields into
// failures that read exactly like real defects.
const CALL_SPACING_MS = Number(
  process.env.GRAPHQL_CONFORMANCE_SPACING_MS ?? 900,
);
const REQUEST_TIMEOUT_MS = 30000;
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 2000;

/**
 * How much of each field's answer to ask for.
 *
 * Not the whole tree: `src/graphql.ts` enforces a depth and a complexity
 * budget, and a greedy selection is rejected by our own guard rather than by
 * the data. Three levels and eight fields per level reaches the scalars that
 * carry the counts -- which is what (2) and (3) above are about -- while
 * staying well inside it.
 */
const MAX_DEPTH = 3;
const MAX_FIELDS_PER_LEVEL = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Concrete values for the arguments a field REQUIRES.
 *
 * The same subjects the parity gates use, so a field that declines here is
 * declining for the same reason its REST twin would. Optional arguments are
 * left out entirely: a field's default answer is the one a caller gets first,
 * and it is the one nothing had ever checked.
 */
const ARGUMENT_FIXTURES: Record<string, unknown> = {
  netuid: 64,
  uid: 0,
  ss58: "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  hotkey: "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  coldkey: "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  address: "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  ref: "4200000",
  slug: "opentensor-foundation",
  provider: "opentensor-foundation",
  id: "sn-64-docs",
  date: "2026-08-01",
  tag: "inference",
  q: "inference",
  query: "inference",
  hash: `0x${"a".repeat(64)}`,
  h160: `0x${"a".repeat(40)}`,
  surface_id: "sn-64-docs",
  crowdloan_id: 0,
  netuids: [1, 64],
  hotkeys: "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  ids: "s64",
};

/**
 * Where the argument's SUBJECT is the field's rather than the name's.
 *
 * `id` is a surface id nearly everywhere and a saved-query name on one field;
 * `slug` is a provider on most and an adapter on one. A shared fixture there
 * reports "unknown saved query" as though the field were broken, which is the
 * one thing a conformance report must not do -- the same reason the MCP sweep
 * reports an undocumented argument instead of guessing one.
 */
const FIELD_ARGUMENT_FIXTURES: Record<string, Record<string, unknown>> = {
  saved_query: { id: "subnet-leaderboard" },
  fixture: { surface_id: "allways-api-health" },
  adapter: { slug: "allways" },
  provider: { id: "academia" },
  provider_endpoints: { slug: "opentensor" },
  provider_detail: { slug: "opentensor" },
};

export interface FieldPlan {
  field: string;
  query: string;
  /** The same field with a shallower selection, for a complexity refusal. */
  narrowQuery: string;
  /** The REST route the SDL says this field mirrors, if it names one. */
  mirrors: string | null;
}

export interface Finding {
  field: string;
  kind: "error" | "null" | "divergence";
  detail: string;
}

export interface ConformanceReport {
  executed: number;
  compared: number;
  /** Fields re-asked with a shallower selection after a complexity refusal. */
  narrowed: string[];
  /** Disagreements that did not reproduce -- one side served a degraded read. */
  transient: string[];
  unfixtured: string[];
  findings: Finding[];
}

function namedTypeOf(type: GraphQLOutputType): GraphQLNamedType {
  let current = type as Row;
  while (current.ofType) current = current.ofType;
  return current as unknown as GraphQLNamedType;
}

function isLeaf(type: GraphQLNamedType): boolean {
  const kind = (type as Row).constructor?.name ?? "";
  return kind === "GraphQLScalarType" || kind === "GraphQLEnumType";
}

function objectFieldsOf(type: GraphQLNamedType): Row | null {
  const getFields = (type as Row).getFields;
  if (typeof getFields !== "function") return null;
  // Unions and interfaces need inline fragments to select through; the fields
  // this sweep is after are all on plain object types.
  if ((type as Row).constructor?.name !== "GraphQLObjectType") return null;
  return (type as GraphQLObjectType).getFields() as unknown as Row;
}

/**
 * A selection set for one output type: its leaves first, then one bounded
 * descent into the objects that carry the rest.
 *
 * Fields with REQUIRED arguments are skipped inside the tree -- a nested field
 * that needs an argument is asking a different question, and guessing one here
 * would report the guess's failure as the field's.
 */
function selectionFor(type: GraphQLNamedType, depth: number): string {
  const fields = objectFieldsOf(type);
  if (!fields) return "";
  const leaves: string[] = [];
  const branches: string[] = [];
  for (const field of Object.values(fields) as GraphQLField<
    unknown,
    unknown
  >[]) {
    if (field.args.some((arg) => String(arg.type).endsWith("!"))) continue;
    const named = namedTypeOf(field.type);
    if (isLeaf(named)) {
      if (leaves.length < MAX_FIELDS_PER_LEVEL) leaves.push(field.name);
      continue;
    }
    if (depth >= MAX_DEPTH || branches.length >= 2) continue;
    const nested = selectionFor(named, depth + 1);
    if (nested) branches.push(`${field.name} ${nested}`);
  }
  const selected = [...leaves, ...branches];
  return selected.length > 0 ? `{ ${selected.join(" ")} }` : "";
}

/** `Mirrors GET /api/v1/…` out of a field's own description. */
export function mirroredRoute(
  description: string | null | undefined,
): string | null {
  const match = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(description ?? "");
  return match ? match[1] : null;
}

function argumentLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(argumentLiteral).join(", ")}]`;
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

/**
 * The query to send for one Query field, or null when a required argument has
 * no fixture -- reported rather than guessed, the same rule
 * `buildToolArguments` follows on the MCP side.
 */
export function planFor(
  field: GraphQLField<unknown, unknown>,
): FieldPlan | null {
  const required = field.args.filter((arg: GraphQLArgument) =>
    String(arg.type).endsWith("!"),
  );
  const overrides = FIELD_ARGUMENT_FIXTURES[field.name] ?? {};
  const supplied: string[] = [];
  for (const arg of required) {
    const value =
      arg.name in overrides ? overrides[arg.name] : ARGUMENT_FIXTURES[arg.name];
    if (value === undefined) return null;
    supplied.push(`${arg.name}: ${argumentLiteral(value)}`);
  }
  const args = supplied.length > 0 ? `(${supplied.join(", ")})` : "";
  const selection = selectionFor(namedTypeOf(field.type), 1);
  return {
    field: field.name,
    query: `{ ${field.name}${args} ${selection} }`,
    // The same field asked for less, for when the full selection trips the
    // surface's own complexity budget. That refusal is this sweep's query
    // being too big, not the field being broken, and reporting it as a
    // finding would be reporting our own probe.
    narrowQuery: `{ ${field.name}${args} ${selectionFor(namedTypeOf(field.type), MAX_DEPTH)} }`,
    mirrors: mirroredRoute(field.description),
  };
}

/** Every Query field the SDL declares, with the query that exercises it. */
export function planAll(schema: GraphQLSchema): {
  plans: FieldPlan[];
  unfixtured: string[];
} {
  const query = schema.getQueryType();
  /* v8 ignore next -- the SDL always declares a Query root. */
  if (!query) return { plans: [], unfixtured: [] };
  const plans: FieldPlan[] = [];
  const unfixtured: string[] = [];
  for (const field of Object.values(query.getFields())) {
    const plan = planFor(field);
    if (plan) plans.push(plan);
    else unfixtured.push(field.name);
  }
  return { plans, unfixtured };
}

async function execute(query: string): Promise<Row> {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let body: Row;
    let status: number;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      status = res.status;
      body = (await res.json()) as Row;
    } finally {
      clearTimeout(timer);
    }
    // A rate-limited call is not a result. Retrying rather than reporting it
    // keeps "this field is broken" out of the same bucket as "we asked too
    // fast" -- the one distinction a conformance report must not lose.
    if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      continue;
    }
    return body;
  }
}

async function restBody(path: string): Promise<Row | null> {
  let resolved = path;
  for (const [name, value] of Object.entries(ARGUMENT_FIXTURES)) {
    resolved = resolved.split(`{${name}}`).join(String(value));
  }
  if (/\{[a-z_0-9]+\}/.test(resolved)) return null;
  const res = await fetch(`${REST_ORIGIN}${resolved}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Row;
  return body?.data && typeof body.data === "object"
    ? (body.data as Row)
    : null;
}

/**
 * Numbers the two surfaces both report for the same key, and disagree on.
 *
 * Exported for the unit test: the transport needs production, the comparison
 * does not, and a comparison nobody can test offline is a comparison nobody
 * checks.
 */
export function numericDivergences(
  graphqlValue: unknown,
  restData: Row,
): string[] {
  if (!graphqlValue || typeof graphqlValue !== "object") return [];
  const divergences: string[] = [];
  for (const [key, value] of Object.entries(graphqlValue as Row)) {
    if (typeof value !== "number") continue;
    // An AGE is computed at read time, so two calls a second apart disagree by
    // construction. Comparing it reports the gap between the two requests as a
    // defect -- measured on the first run: `head_age_ms` 39130 vs 40076, one
    // second of elapsed time reported as a contract violation.
    if (/_age_ms$|^age_ms$/.test(key)) continue;
    const rest = restData[key];
    if (typeof rest !== "number") continue;
    if (value !== rest)
      divergences.push(`${key}: graphql ${value}, rest ${rest}`);
  }
  return divergences;
}

export async function run(): Promise<ConformanceReport> {
  const schema = buildSchema(SDL);
  const { plans, unfixtured } = planAll(schema);
  const report: ConformanceReport = {
    executed: 0,
    compared: 0,
    narrowed: [],
    transient: [],
    unfixtured,
    findings: [],
  };

  for (const plan of plans) {
    let body = await execute(plan.query);
    await sleep(CALL_SPACING_MS);
    if (
      /Query complexity \d+ exceeds/.test(String(body?.errors?.[0]?.message))
    ) {
      report.narrowed.push(plan.field);
      body = await execute(plan.narrowQuery);
      await sleep(CALL_SPACING_MS);
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      report.findings.push({
        field: plan.field,
        kind: "error",
        detail: String(body.errors[0]?.message ?? "unknown error"),
      });
      continue;
    }
    report.executed += 1;
    const value = body?.data?.[plan.field];
    if (value === null || value === undefined) {
      report.findings.push({
        field: plan.field,
        kind: "null",
        detail: "resolved to null against production",
      });
      continue;
    }
    if (!plan.mirrors) continue;
    const rest = await restBody(plan.mirrors);
    if (!rest) continue;
    report.compared += 1;
    const divergences = numericDivergences(value, rest);
    if (divergences.length === 0) continue;

    // ASK BOTH SIDES AGAIN before reporting. A single disagreement cannot
    // distinguish "these two surfaces answer differently" from "one of these
    // two calls hit a degraded read" -- and the second really happens:
    // /accounts/{ss58}/counterparties served `counterparty_count: 0` on 1 of 5
    // consecutive requests for an account with 114, measured while this check
    // was being written. Reporting that as a cross-surface divergence would
    // name the wrong defect AND make the check flaky, which is how a scheduled
    // check gets turned off.
    //
    // The transient is a real defect of its own -- it is just not this one.
    await sleep(CALL_SPACING_MS);
    const confirmValue = (await execute(plan.query))?.data?.[plan.field];
    const confirmRest = await restBody(plan.mirrors);
    const confirmed = confirmRest
      ? new Set(numericDivergences(confirmValue, confirmRest))
      : new Set<string>();
    for (const divergence of divergences) {
      if (!confirmed.has(divergence)) {
        report.transient.push(`${plan.field} ${divergence}`);
        continue;
      }
      report.findings.push({
        field: plan.field,
        kind: "divergence",
        detail: `${plan.mirrors} ${divergence}`,
      });
    }
  }
  return report;
}

export function formatReport(report: ConformanceReport): string {
  const lines = [
    `Query fields executed against production: ${report.executed}`,
    `of those, compared numerically against the REST route they mirror: ${report.compared}`,
  ];
  if (report.narrowed.length > 0) {
    lines.push(
      `re-asked with a shallower selection (complexity budget): ${report.narrowed.join(", ")}`,
    );
  }
  if (report.transient.length > 0) {
    lines.push(
      `disagreed once and agreed on re-ask -- one side served a degraded read: ${report.transient.join(", ")}`,
    );
  }
  if (report.unfixtured.length > 0) {
    lines.push(
      `not callable -- a required argument has no fixture: ${report.unfixtured.join(", ")}`,
    );
  }
  if (report.findings.length === 0) {
    lines.push("");
    lines.push("Every field answered, and no answer contradicted its route.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${report.findings.length} FINDING(S):`);
  for (const finding of report.findings) {
    lines.push(`  [${finding.kind}] ${finding.field}: ${finding.detail}`);
  }
  return lines.join("\n");
}

// Guarded so the module can be imported by its test without sweeping
// production, matching scripts/check-mcp-conformance.ts.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")
) {
  const report = await run();
  console.log(formatReport(report));
  if (report.findings.length > 0) process.exitCode = 1;
  // Zero executed fields means the sweep did not run, not that everything
  // passed -- without this the check reports a clean sheet after an outage.
  if (report.executed === 0) {
    console.error(
      "No field was executed at all -- treating as a failure rather than a clean run.",
    );
    process.exitCode = 1;
  }
}
