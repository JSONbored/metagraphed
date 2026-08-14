// Do the three surfaces answer the same question with the same NUMBER? (#10217)
//
// Schema parity is proven three ways -- REST<->MCP inputs (#10064), SDL<->routes
// (#10065), each response against its own schema (conformance:mcp,
// conformance:graphql). Not one of them compares the VALUES. Every gate asks
// "is this the right shape?"; none asks "is this the right number?"
//
// An empty array is schema-valid on all three surfaces, which is why #10200
// (`surfaces: []` on two of three) and #10246 (`chain_transfers` 0 against its
// REST twin's 2,859,197 in the same second) both survived every static check
// and were found by hand.
//
// WHAT IS COMPARED. For each triple that already DECLARES it mirrors the
// others -- `MCP_TOOL_ROUTES` on one side, the SDL's `Mirrors GET` annotation
// on the other -- the top-level scalars each surface publishes, plus whether an
// array is empty on one surface and not another. Nested comparison is
// deliberately out: the three surfaces legitimately shape their nesting
// differently (GraphQL renames a page's rows to `items`), and a deep diff would
// report that as a defect on every route.
//
// OUT OF BAND, like its three siblings, and for the same reason: it needs
// production data, and a check that cannot run on a pull request should not
// pretend to.
import { buildSchema } from "graphql";
import { SDL } from "../generated/graphql/schema.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";
import { planAll, type FieldPlan } from "./check-graphql-conformance.ts";
import { concreteRoute, toolArguments } from "./conformance-subjects.ts";

type Row = Record<string, unknown>;

/** Read a nested key off an untyped body without widening the whole file. */
const at = (row: unknown, ...keys: string[]): unknown => {
  let current = row;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Row)[key];
  }
  return current;
};

// `/api/v1/graphql`, not `/graphql`. The bare path 404s with
// `no route matched this path` and a 404 body has no `data`, so the first run
// of this sweep reported all 191 triples as "graphql did not answer" -- a
// harness bug that reads exactly like a dead surface.
const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT ?? "https://api.metagraph.sh/api/v1/graphql";
const MCP_ENDPOINT = process.env.MCP_ENDPOINT ?? "https://api.metagraph.sh/mcp";
const REST_ORIGIN = process.env.REST_ORIGIN ?? "https://api.metagraph.sh";
const CALL_SPACING_MS = Number(process.env.CROSS_SURFACE_SPACING_MS ?? 1600);
const REQUEST_TIMEOUT_MS = 30000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keys whose value is computed at READ time, so two calls a second apart
 * disagree by construction.
 *
 * The GraphQL sweep learned this on its first run: `head_age_ms` 39130 against
 * 40076 is one second of elapsed time reported as a contract violation. Three
 * surfaces means three call instants, so the window is wider here, not
 * narrower.
 */
const TIME_DEPENDENT = /_age_ms$|^age_ms$|_at$|^now$|elapsed|uptime_seconds/;

/**
 * Differences that are real and intended, each with the reason.
 *
 * The list must SHRINK: an entry that no longer names a live difference fails
 * this script, so a fix cannot leave a stale exemption behind -- the same idiom
 * the MCP input-parity, tier-cascade and vocabulary gates use.
 *
 * Keyed `<tool>.<field>`, because a difference is per-surface-pair per-field
 * and "this route disagrees somewhere" is not a fact anyone can act on.
 */
/**
 * EMPTY, which is the goal state rather than a missing list.
 *
 * Every entry this sweep opened with has been closed rather than tolerated:
 *
 *   #10306  five entries -- `get_chain_subnet_lifecycle` served 100 against a
 *           published 50, and `get_subnet_identity_history` applied no page
 *           default at all, so it answered `entry_count: 0` for a subnet that
 *           had changed identity. The MCP dispatcher now serves the default
 *           each tool publishes.
 *   #10307  one entry -- `tao_inflow_per_day`, 89.4820752 on REST against
 *           91.04839199999999 on MCP for the same subnet, both stable. The
 *           tool was reading the published artifact where REST reads the live
 *           tier first; both now climb one shared ladder.
 *
 * A stale entry FAILS this script, so the list cannot grow back quietly.
 */
const DECLARED: Record<string, string> = {};

interface Divergence {
  tool: string;
  route: string;
  key: string;
  detail: string;
}

export interface CrossSurfaceReport {
  triples: number;
  compared: number;
  /** A surface that declined -- not a value disagreement. */
  declined: string[];
  /** A triple we could not assemble: no MCP tool, or no fixtured query. */
  unpaired: string[];
  divergences: Divergence[];
  stale: string[];
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A DEGRADED answer is not a disagreement, and the header is the only way to
 * tell.
 *
 * #10270 put `x-metagraph-degraded: tier_unavailable` on exactly this case: the
 * lakehouse declines, the route serves a schema-stable empty card, and the BODY
 * is indistinguishable from a measured zero. This sweep hit it on its first
 * full run -- `get_account_counterparties` answered 0 against GraphQL's 114,
 * and `get_account_transfers` 0 against 100, in the same three minutes.
 *
 * Reporting that as a cross-surface divergence would blame the wrong thing: the
 * surfaces agree about the data, one of them just could not read it this time.
 * So a labelled response counts as "did not answer" and lands in the incomplete
 * bucket, where a declining surface belongs.
 *
 * ALL THREE SURFACES SET IT, and until now only REST was asked. Measured
 * 2026-08-14 against production, forcing the r2-sql timeout on
 * /accounts/{ss58}/transfers: REST, the GraphQL POST and the MCP POST each
 * answered the 15s abort with `x-metagraph-degraded: tier_unavailable`. Reading
 * it on one surface only is what produced this sweep's three-day red streak --
 * `get_account_transfers transfer_count: rest 100, graphql 0` was GraphQL
 * declining, correctly labelled, and scored as a disagreement because nothing
 * looked at the label.
 */
function degradedHeader(res: Response): string | null {
  return res.headers.get("x-metagraph-degraded");
}

async function restBody(path: string): Promise<Row | null> {
  try {
    const answer = await withTimeout(async (signal) => {
      const res = await fetch(`${REST_ORIGIN}${path}`, { signal });
      return { degraded: degradedHeader(res), body: (await res.json()) as Row };
    });
    if (answer.degraded) return null;
    const data = at(answer.body, "data");
    return at(answer.body, "ok") === true && data && typeof data === "object"
      ? (data as Row)
      : null;
  } catch {
    return null;
  }
}

async function graphqlField(plan: FieldPlan): Promise<Row | null> {
  try {
    const answer = await withTimeout(async (signal) => {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: plan.query }),
        signal,
      });
      return { degraded: degradedHeader(res), body: (await res.json()) as Row };
    });
    if (answer.degraded) return null;
    const value = at(answer.body, "data", plan.field);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Row)
      : null;
  } catch {
    return null;
  }
}

/**
 * The first path-parameter value REST is asked about that the GraphQL query
 * does not mention, or null when they agree.
 *
 * Compares VALUES rather than names because that is what actually has to match:
 * the two sweeps fill their arguments from separate tables, and a comparison
 * across surfaces is only meaningful when both were handed the same subject.
 *
 * Only path parameters are checked. A query-string default that differs is a
 * real divergence to report -- two surfaces answering the same subject with
 * different defaults is exactly what this sweep exists to find.
 */
function mismatchedSubject(
  template: string,
  path: string,
  query: string,
): string | null {
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  if (names.length === 0) return null;
  const templateParts = template.split("/");
  const pathParts = path.split("?")[0]!.split("/");
  for (const [index, part] of templateParts.entries()) {
    if (!part.startsWith("{") || !part.endsWith("}")) continue;
    const value = pathParts[index];
    if (!value) continue;
    const decoded = decodeURIComponent(value);
    if (!query.includes(decoded)) {
      return `${part} rest=${decoded}`;
    }
  }
  return null;
}

let rpcId = 0;
async function mcpTool(name: string, args: Row): Promise<Row | null> {
  try {
    const answer = await withTimeout(async (signal) => {
      const res = await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: (rpcId += 1),
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal,
      });
      return { degraded: degradedHeader(res), body: (await res.json()) as Row };
    });
    if (answer.degraded) return null;
    const body = answer.body;
    if (at(body, "error") || at(body, "result", "isError")) return null;
    const structured = at(body, "result", "structuredContent");
    return structured && typeof structured === "object"
      ? (structured as Row)
      : null;
  } catch {
    return null;
  }
}

/**
 * Compare the top level of two answers to one question.
 *
 * SCALARS AND EMPTINESS only. A number that differs is the #10246 shape; an
 * array empty on one surface and populated on another is the #10200 shape.
 * Anything deeper is where the three surfaces legitimately differ in how they
 * nest, and reporting that would bury the two findings that matter.
 */
export function compareTopLevel(
  left: Row,
  right: Row,
  leftName: string,
  rightName: string,
): { key: string; detail: string }[] {
  const out: { key: string; detail: string }[] = [];
  for (const [key, value] of Object.entries(left)) {
    if (TIME_DEPENDENT.test(key)) continue;
    if (!(key in right)) continue;
    const other = right[key];
    if (typeof value === "number" && typeof other === "number") {
      if (value !== other) {
        out.push({
          key,
          detail: `${leftName} ${value}, ${rightName} ${other}`,
        });
      }
      continue;
    }
    if (Array.isArray(value) && Array.isArray(other)) {
      const emptyHere = value.length === 0;
      const emptyThere = other.length === 0;
      if (emptyHere !== emptyThere) {
        out.push({
          key,
          detail: `${leftName} ${value.length} row(s), ${rightName} ${other.length}`,
        });
      }
      continue;
    }
    if (
      (typeof value === "string" || typeof value === "boolean") &&
      typeof other === typeof value &&
      value !== other
    ) {
      out.push({
        key,
        detail: `${leftName} ${JSON.stringify(value)}, ${rightName} ${JSON.stringify(other)}`,
      });
    }
  }
  return out;
}

export async function run(): Promise<CrossSurfaceReport> {
  const schema = buildSchema(SDL);
  const { plans } = planAll(schema);
  /** route template -> the GraphQL field that mirrors it. */
  const graphqlByRoute = new Map<string, FieldPlan>();
  for (const plan of plans) {
    if (plan.mirrors && !graphqlByRoute.has(plan.mirrors)) {
      graphqlByRoute.set(plan.mirrors, plan);
    }
  }

  const report: CrossSurfaceReport = {
    triples: 0,
    compared: 0,
    declined: [],
    unpaired: [],
    divergences: [],
    stale: [],
  };
  const matched = new Set<string>();

  for (const [tool, binding] of Object.entries(MCP_TOOL_ROUTES)) {
    const template = binding.route;
    if (!template) continue;
    const plan = graphqlByRoute.get(template);
    const path = concreteRoute(template);
    if (!plan || !path) {
      report.unpaired.push(
        `${tool} (${template}) -- ${!plan ? "no GraphQL field mirrors it" : "a path parameter has no fixture"}`,
      );
      continue;
    }
    // The three surfaces must be asked the SAME question before their answers
    // mean anything together. They are subjected independently -- REST from
    // conformance-subjects.ts's SUBJECTS, GraphQL from
    // check-graphql-conformance.ts's own ARGUMENT_FIXTURES -- and the two tables
    // have drifted: `h160` is 0x1212..12 in one and 0xaaaa..aa in the other. The
    // sweep duly reported that /evm/address/{h160} "diverges", when it had asked
    // the two surfaces about two different addresses.
    //
    // The plan bakes its arguments into `query`, so the check is whether every
    // subject value in the concrete REST path appears there. Cheap, and general
    // over any future drift rather than over the one key that drifted.
    const subject = mismatchedSubject(template, path, plan.query);
    if (subject) {
      report.unpaired.push(
        `${tool} (${template}) -- surfaces asked different subjects (${subject})`,
      );
      continue;
    }
    report.triples += 1;
    // PROGRESS ON STDERR, one line per triple. Three calls plus three sleeps
    // over ~150 triples is ten-plus minutes of nothing, and a run that hangs on
    // a slow surface looks exactly like a run that is still working. stderr so
    // the report on stdout stays the artefact.
    process.stderr.write(`[${report.triples}] ${tool} ${path}\n`);

    const rest = await restBody(path);
    await sleep(CALL_SPACING_MS);
    const mcp = await mcpTool(tool, toolArguments(template));
    await sleep(CALL_SPACING_MS);
    const graphql = await graphqlField(plan);
    await sleep(CALL_SPACING_MS);

    const missing = [
      rest ? null : "rest",
      mcp ? null : "mcp",
      graphql ? null : "graphql",
    ].filter(Boolean);
    if (missing.length > 0) {
      // A surface that declined is not a value disagreement, and its own
      // conformance sweep is what reports it. Saying so here keeps "we could
      // not compare" out of the same bucket as "they disagree".
      report.declined.push(`${tool}: ${missing.join(", ")} did not answer`);
      continue;
    }
    report.compared += 1;

    const pairs: [Row, Row, string, string][] = [
      [rest!, mcp!, "rest", "mcp"],
      [rest!, graphql!, "rest", "graphql"],
    ];
    for (const [left, right, leftName, rightName] of pairs) {
      for (const { key, detail } of compareTopLevel(
        left,
        right,
        leftName,
        rightName,
      )) {
        const declaredKey = `${tool}.${key}`;
        if (DECLARED[declaredKey]) {
          matched.add(declaredKey);
          continue;
        }
        report.divergences.push({ tool, route: template, key, detail });
      }
    }
  }

  report.stale = Object.keys(DECLARED).filter((key) => !matched.has(key));
  return report;
}

export function formatReport(report: CrossSurfaceReport): string {
  const lines = [
    `cross-surface values: ${report.triples} triple(s), ${report.compared} compared, ` +
      `${report.divergences.length} divergence(s), ${report.declined.length} incomplete, ` +
      `${report.unpaired.length} unpaired.`,
  ];
  for (const divergence of report.divergences) {
    lines.push(
      `  - ${divergence.tool} (${divergence.route}) ${divergence.key}: ${divergence.detail}`,
    );
  }
  if (report.stale.length > 0) {
    lines.push(
      `  ${report.stale.length} stale DECLARED entr(y/ies) -- the difference is gone, delete them:`,
    );
    for (const key of report.stale) lines.push(`    - ${key}`);
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await run();
  console.log(formatReport(report));
  if (report.declined.length > 0) {
    console.log("\nIncomplete triples (a surface declined):");
    for (const line of report.declined) console.log(`  - ${line}`);
  }
  if (report.unpaired.length > 0) {
    console.log(`\nUnpaired (${report.unpaired.length}):`);
    for (const line of report.unpaired.slice(0, 20)) console.log(`  - ${line}`);
  }
  if (report.divergences.length > 0 || report.stale.length > 0) process.exit(1);
}
