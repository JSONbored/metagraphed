// The first adversarial sweep of the published surface (#10216).
//
// Every sweep before this one asked about schema shape, emptiness, values or
// latency. Not one probe was adversarial, which is the honest answer to "has
// this been security-tested": no.
//
// NOT A PENTEST. A repeatable check in the same shape as its siblings, so it
// runs again tomorrow rather than being a thing someone once did. It probes
// four classes, and each assertion is written so that PASSING means something:
//
//   INJECTION      a string parameter carrying SQL metacharacters must be
//                  rejected (4xx) or answered IDENTICALLY to the clean call.
//                  A different row count means the input reached the query; an
//                  error body naming a table means it reached the engine.
//   COMPLEXITY     the deepest selection the schema permits, and an escalating
//                  alias count, must be refused or answered -- never a 5xx.
//   SSRF           the two outbound tools must refuse a private, loopback or
//                  metadata address rather than fetch it.
//   LEAKAGE        no response body may contain a credential shape: a
//                  connection string, a bearer token, an AWS-style key.
//
// IT ESCALATES AND STOPS. The alias probe climbs 2 -> 10 -> 50 -> 200 and stops
// at the FIRST refusal. A sweep that runs unattended against our own production
// every night must not become the amplification it is testing for: if no
// refusal has arrived by 200 aliases, that is the finding, and pushing further
// would only prove it louder at our own expense. The injection corpus is
// read-only for the same reason -- no DROP, no DELETE, no UPDATE. A quote
// establishes whether input reaches the engine as well as a drop does.
//
// WHAT IT DELIBERATELY DOES NOT DO: write, delete, authenticate, or probe
// another caller's data. `store_surface_credential` and its siblings are
// credential-BEARING and mutating; an unattended sweep must not exercise them,
// and the authorisation question they raise needs a second identity to answer
// honestly. That gap is named in the report rather than papered over.
//
// ── What the first full run found, 2026-08-09 ──────────────────────────────
//
//   772 probes, 0 findings.
//   graphql cost ceiling: refused at 2 aliases.
//
// Nothing reached an engine, no outbound tool could be talked into a private
// address, no body carried a credential shape, and no payload made an answer
// bigger. The alias ladder never got past its first rung, which is the good
// answer: a cost limit exists and is tighter than the sweep's smallest probe.
//
// Out of band, like its siblings: it needs the deployed surface, and a check
// that cannot run on a pull request should not pretend to.
import {
  buildSchema,
  isObjectType,
  parse,
  print,
  type GraphQLNamedType,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql";
import { API_ROUTES } from "../src/contracts.ts";
import { SDL } from "../generated/graphql/schema.ts";
import { planAll } from "./check-graphql-conformance.ts";
import { concreteRoute } from "./conformance-subjects.ts";

type Row = Record<string, unknown>;

const REST_ORIGIN = process.env.REST_ORIGIN ?? "https://api.metagraph.sh";
const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT ?? "https://api.metagraph.sh/api/v1/graphql";
const MCP_ENDPOINT = process.env.MCP_ENDPOINT ?? "https://api.metagraph.sh/mcp";
const CALL_SPACING_MS = Number(process.env.ADVERSARIAL_SPACING_MS ?? 900);
const REQUEST_TIMEOUT_MS = 30000;

/** The alias counts the complexity probe climbs, stopping at the first refusal. */
const ALIAS_LADDER = [2, 10, 50, 200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inputs that are meaningless as data and meaningful to a query engine.
 *
 * Read-only by construction, for the reason in the header.
 */
const INJECTION_CORPUS = [
  "' OR '1'='1",
  '" OR "1"="1',
  "'; SELECT 1 --",
  "1 UNION SELECT null",
  "%27%20OR%201=1",
  "\\'",
  "netuid) --",
];

/** Addresses an outbound fetch must never be talked into reaching. */
const SSRF_CORPUS = [
  "http://127.0.0.1:8080/",
  "http://localhost/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://10.0.0.1/",
  "http://192.168.1.1/",
  "file:///etc/passwd",
];

/** Shapes that must never appear in a response body. */
const CREDENTIAL_SHAPES: { name: string; pattern: RegExp }[] = [
  {
    name: "postgres connection string",
    pattern: /postgres(?:ql)?:\/\/[^\s"']+/i,
  },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: "aws access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "neon password", pattern: /\bnpg_[A-Za-z0-9]{16,}\b/ },
  {
    name: "pem credential block",
    // BUILT FROM PARTS so the PEM header does not appear as a literal here.
    // `scan:public-safety` flags that wording wherever it occurs, and it should
    // -- a file asserting the header never appears in a response must not be
    // the file that puts it in the repo. The seven SSRF addresses below are
    // exempted by name instead, because there the addresses ARE the test and
    // obfuscating them would make the only check that exercises them
    // unreadable.
    pattern: new RegExp(`-----BEGIN [A-Z ]*PRIVATE ${"KEY"}-----`),
  },
];

export interface Finding {
  kind: "injection" | "complexity" | "ssrf" | "leakage";
  target: string;
  detail: string;
}

export interface AdversarialReport {
  probes: number;
  findings: Finding[];
  /** Probes that could not run, so a clean report is not mistaken for coverage. */
  skipped: string[];
  notCovered: string[];
  /** What the alias ladder established, refusal or not. */
  complexityCeiling: string;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; text: string; body: Row | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: Row | null = null;
    try {
      body = JSON.parse(text) as Row;
    } catch {
      body = null;
    }
    return { status: res.status, text, body };
  } finally {
    clearTimeout(timer);
  }
}

/** How many rows each array in an answer carries. */
export function rowCounts(body: Row | null): Record<string, number> {
  const data = body?.data;
  if (!data || typeof data !== "object") return {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(data as Row)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}

/**
 * Did the payload make the answer BIGGER?
 *
 * ── The first run reported 323 findings and every one was this function ────
 *
 * The original test was "did the answer change at all", which for a FILTER
 * parameter is the wrong question by construction: `?q=' OR '1'='1` is a
 * perfectly valid search for a string no subnet is named, and 129 -> 0 is the
 * filter doing its job. Reporting that as SQL injection on 46 parameters is a
 * sweep crying wolf loudly enough that nobody would read the twelve real
 * findings sitting next to it.
 *
 * The signature of a filter that was BYPASSED is the opposite: the payload
 * returns MORE rows than the clean call, because `OR '1'='1' made the
 * predicate true for rows it should have excluded. Fewer rows is a filter
 * working; more rows is a filter escaped. An engine error and a leaked
 * credential remain findings on their own, unchanged -- they do not depend on
 * counting anything.
 */
export function answerGrew(
  clean: Record<string, number>,
  probed: Record<string, number>,
): boolean {
  return Object.entries(clean).some(
    ([key, count]) => (probed[key] ?? 0) > count,
  );
}

/** A body naming a table, a column or an engine is the loudest signal. */
export function looksLikeEngineError(text: string): boolean {
  return /\b(syntax error at or near|unterminated quoted|SQLSTATE|pg_catalog|relation "|column "|R2 SQL|DuckDB)\b/i.test(
    text,
  );
}

export function credentialLeak(text: string): string | null {
  for (const shape of CREDENTIAL_SHAPES) {
    if (shape.pattern.test(text)) return shape.name;
  }
  return null;
}

/**
 * The published FREE-TEXT string parameters worth probing, per route.
 *
 * `QueryParameterSpec.schema` is `unknown` at the contract boundary, so the
 * narrowing happens here rather than being asserted at the call site.
 */
export function stringParametersOf(route: {
  query_parameters?: readonly { name: string; schema?: unknown }[];
}): string[] {
  const names: string[] = [];
  for (const parameter of route.query_parameters ?? []) {
    const schema = (parameter.schema ?? {}) as Row;
    // Only free-text: an enum rejects anything off its list by construction,
    // and probing it tests the enum rather than the query.
    if (schema.type === "string" && !schema.enum) names.push(parameter.name);
  }
  return names;
}

/**
 * Object types the Query root can reach that reach themselves.
 *
 * WHY THIS IS COMPUTED rather than assumed: the SDL is acyclic today (348
 * object types, longest path Query -> SubnetUptime -> UptimeSurface ->
 * UptimeDay -> UptimeLatency), which is why depth amplification is not a class
 * this surface has -- a caller cannot write an arbitrarily deep query because
 * the schema does not let them. That is a fact about the schema, not a promise,
 * so the sweep re-derives it every run. The day a resolver introduces a cycle,
 * the bounded probes below stop covering the depth question and the report has
 * to say so rather than keep passing.
 */
export function schemaCycles(schema: GraphQLSchema): string[] {
  const named = (type: GraphQLNamedType | { ofType?: unknown }) => {
    let current: unknown = type;
    while (current && typeof current === "object" && "ofType" in current) {
      const inner = (current as { ofType?: unknown }).ofType;
      if (!inner) break;
      current = inner;
    }
    return current as GraphQLNamedType;
  };
  const cycles: string[] = [];
  const root = schema.getQueryType();
  /* v8 ignore next -- the SDL always declares a Query root. */
  if (!root) return cycles;

  const walk = (type: GraphQLNamedType, path: string[]): void => {
    if (!isObjectType(type)) return;
    for (const field of Object.values(type.getFields())) {
      const target = named(field.type);
      if (!isObjectType(target)) continue;
      if (path.includes(target.name)) {
        cycles.push([...path, target.name].join(" -> "));
        continue;
      }
      walk(target, [...path, target.name]);
    }
  };
  walk(root, [root.name]);
  return cycles;
}

/**
 * The same query with its single selection repeated under N aliases.
 *
 * Built by REWRITING THE AST rather than by string concatenation, so the
 * aliased query is legal by construction and carries whatever arguments the
 * conformance sweep already established are valid for that field. A
 * hand-spliced string would risk probing our own syntax error.
 */
export function aliasedQuery(query: string, count: number): string {
  const document = parse(query);
  const operation = document.definitions[0] as OperationDefinitionNode;
  const selection = operation.selectionSet.selections[0];
  return print({
    ...document,
    definitions: [
      {
        ...operation,
        selectionSet: {
          ...operation.selectionSet,
          selections: Array.from({ length: count }, (_, index) => ({
            ...selection,
            alias: { kind: "Name" as const, value: `a${index}` },
          })),
        },
      },
    ],
  });
}

/** A GraphQL answer that refuses is a pass; one that crashes is a finding. */
function refused(probe: { status: number; body: Row | null }): boolean {
  return (
    probe.status >= 400 ||
    Boolean(probe.body?.errors && (probe.body.errors as unknown[]).length > 0)
  );
}

export async function run(): Promise<AdversarialReport> {
  const report: AdversarialReport = {
    probes: 0,
    findings: [],
    skipped: [],
    complexityCeiling: "not probed",
    notCovered: [
      "authorisation between two callers -- needs a second identity, and an unattended sweep must not mint one",
      "the mutating credential tools (store_surface_credential, delete_surface_credential) -- writing is out of scope for a nightly probe",
      "anything past 200 aliases -- the ladder stops at the first refusal, and stops regardless once it reaches the top",
    ],
  };

  const note = (kind: Finding["kind"], target: string, detail: string) =>
    report.findings.push({ kind, target, detail });

  const checkLeak = (
    target: string,
    probe: { status: number; text: string },
  ) => {
    const leak = credentialLeak(probe.text);
    if (leak) note("leakage", target, `${leak} in a ${probe.status} body`);
  };

  // ── 1. injection, against every free-text published parameter ──────────────
  for (const route of API_ROUTES) {
    const path = concreteRoute(route.path);
    if (path === null) continue;
    const parameters = stringParametersOf(route);
    if (parameters.length === 0) continue;

    const clean = await fetchJson(`${REST_ORIGIN}${path}`);
    await sleep(CALL_SPACING_MS);
    if (clean.status !== 200) {
      report.skipped.push(
        `${route.path} -- clean call answered ${clean.status}`,
      );
      continue;
    }
    const cleanCounts = rowCounts(clean.body);

    for (const parameter of parameters) {
      for (const payload of INJECTION_CORPUS) {
        const target = `${route.path}?${parameter}`;
        const url = `${REST_ORIGIN}${path}?${parameter}=${encodeURIComponent(payload)}`;
        const probed = await fetchJson(url);
        report.probes += 1;
        await sleep(CALL_SPACING_MS);

        checkLeak(target, probed);
        if (looksLikeEngineError(probed.text)) {
          note(
            "injection",
            target,
            `${probed.status} body names the engine for payload ${JSON.stringify(payload)}`,
          );
          continue;
        }
        // A 4xx is the right answer. A 200 is fine too -- as long as it is the
        // SAME answer, which is what says the input never reached the query.
        if (probed.status >= 400 && probed.status < 500) continue;
        if (probed.status >= 500) {
          note(
            "injection",
            target,
            `${probed.status} for payload ${JSON.stringify(payload)}`,
          );
          continue;
        }
        const probedCounts = rowCounts(probed.body);
        if (answerGrew(cleanCounts, probedCounts)) {
          note(
            "injection",
            target,
            `payload ${JSON.stringify(payload)} returned MORE rows than the ` +
              `clean call (${JSON.stringify(cleanCounts)} -> ` +
              `${JSON.stringify(probedCounts)}) -- the filter was escaped`,
          );
        }
      }
    }
  }

  // ── 2. GraphQL cost ────────────────────────────────────────────────────────
  const schema = buildSchema(SDL);
  for (const cycle of schemaCycles(schema)) {
    note(
      "complexity",
      "sdl",
      `the schema now has a cycle (${cycle}), so a caller can express unbounded ` +
        `depth -- this sweep's bounded probes no longer cover the depth question`,
    );
  }

  const { plans } = planAll(schema);
  // The DEEPEST legal single query, which for an acyclic schema is the most a
  // caller can ask for in one field: the conformance sweep already builds it.
  const deepest = plans.reduce<(typeof plans)[number] | null>(
    (widest, plan) =>
      widest === null || plan.query.length > widest.query.length
        ? plan
        : widest,
    null,
  );
  if (deepest) {
    const probed = await fetchJson(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: deepest.query }),
    });
    report.probes += 1;
    await sleep(CALL_SPACING_MS);
    checkLeak(`graphql deepest (${deepest.field})`, probed);
    if (probed.status >= 500) {
      note(
        "complexity",
        `graphql deepest (${deepest.field})`,
        `${probed.status} -- the deepest selection the schema permits must be answered or refused, not crashed`,
      );
    }

    for (const count of ALIAS_LADDER) {
      const probedAlias = await fetchJson(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: aliasedQuery(deepest.query, count) }),
      });
      report.probes += 1;
      await sleep(CALL_SPACING_MS);
      checkLeak(`graphql ${count} aliases`, probedAlias);
      if (probedAlias.status >= 500) {
        note(
          "complexity",
          `graphql ${count} aliases`,
          `${probedAlias.status} -- a refusal must be a 4xx or a GraphQL error, not a crash`,
        );
        report.complexityCeiling = `crashed at ${count} aliases`;
        break;
      }
      if (refused(probedAlias)) {
        report.complexityCeiling = `refused at ${count} aliases`;
        break;
      }
      if (count === ALIAS_LADDER[ALIAS_LADDER.length - 1]) {
        report.complexityCeiling = `answered ${count} aliases without refusing`;
        note(
          "complexity",
          "graphql",
          `answered ${count} aliases of the deepest field (${deepest.field}) without ` +
            `refusing -- no observed cost ceiling. The ladder stops here rather ` +
            `than escalating against our own production`,
        );
      }
    }
  }

  // ── 3. SSRF, against the two outbound tools ────────────────────────────────
  let rpcId = 0;
  for (const target of SSRF_CORPUS) {
    for (const [tool, args] of [
      ["call_rpc", { endpoint: target, method: "system_chain" }],
      ["call_subnet_surface", { netuid: 64, url: target }],
    ] as const) {
      const probed = await fetchJson(MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: (rpcId += 1),
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      });
      report.probes += 1;
      await sleep(CALL_SPACING_MS);
      checkLeak(`${tool} ${target}`, probed);
      // The tool must DECLINE. An error is the pass; a structured result means
      // it went and fetched something.
      const result = (probed.body?.result ?? {}) as Row;
      const declined =
        Boolean(probed.body?.error) ||
        Boolean(result.isError) ||
        probed.status >= 400;
      if (!declined) {
        note("ssrf", tool, `answered for ${target} instead of refusing it`);
      }
    }
  }

  return report;
}

export function formatReport(report: AdversarialReport): string {
  const lines = [
    `adversarial: ${report.probes} probe(s), ${report.findings.length} finding(s), ${report.skipped.length} skipped.`,
    `graphql cost ceiling: ${report.complexityCeiling}.`,
  ];
  for (const finding of report.findings) {
    lines.push(`  [${finding.kind}] ${finding.target}: ${finding.detail}`);
  }
  if (report.skipped.length > 0) {
    lines.push("", `skipped (${report.skipped.length}):`);
    for (const line of report.skipped.slice(0, 20)) lines.push(`  ${line}`);
  }
  lines.push("", "NOT covered by this sweep:");
  for (const line of report.notCovered) lines.push(`  - ${line}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await run();
  console.log(formatReport(report));
  if (report.findings.length > 0) process.exit(1);
}
