// How long does every published operation actually take? (#10220)
//
// Performance had been measured on SIX operations out of 624 -- the six named
// in #9789, found by hand when someone noticed a slow call. Nothing had ever
// timed the other 618, so "which of our endpoints is slow" was answerable only
// for the ones somebody had already complained about.
//
// WHAT IT TIMES. Every REST route in `API_ROUTES` and `FEED_ROUTES` whose path
// parameters have a subject, every MCP tool the live server advertises whose
// required arguments have one, and every GraphQL Query field the conformance
// sweep can plan -- one call each, wall clock, serial.
//
// The subjects come from `conformance-subjects.ts`, shared with the
// cross-surface sweep, and a route whose parameter has no subject is SKIPPED
// rather than filled with a placeholder. Timing `/api/v1/subnets/x/ohlc` times
// a 404 and reports the route as broken.
//
// ONE CALL EACH, NOT A BENCHMARK, and the report says so. A single sample
// cannot separate a slow operation from a cold isolate or a noisy hop, which is
// why the budget below is deliberately loose: it exists to catch the ten-second
// operation, not to police the difference between 300ms and 500ms. Anything
// tighter would fail on weather.
//
// SERIAL AND SPACED, for the reason the MCP sweep records: the endpoint
// rate-limits per client, and a parallel run turns healthy operations into
// `Too many MCP requests` -- a sweep manufacturing failures that read exactly
// like real defects.
//
// Out of band, like its siblings: it needs production, and a check that cannot
// run on a pull request should not pretend to.
import { buildSchema } from "graphql";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import { API_ROUTES, FEED_ROUTES } from "../src/contracts.ts";
import { SDL } from "../src/graphql-sdl.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";
import { planAll, type FieldPlan } from "./check-graphql-conformance.ts";
import { argumentsForRequired, concreteRoute } from "./conformance-subjects.ts";

type Row = Record<string, unknown>;

const REST_ORIGIN = process.env.REST_ORIGIN ?? "https://api.metagraph.sh";
const MCP_ENDPOINT = process.env.MCP_ENDPOINT ?? "https://api.metagraph.sh/mcp";
const GRAPHQL_ENDPOINT =
  process.env.GRAPHQL_ENDPOINT ?? "https://api.metagraph.sh/api/v1/graphql";
const CALL_SPACING_MS = Number(process.env.LATENCY_SPACING_MS ?? 1600);
const REQUEST_TIMEOUT_MS = 45000;

/**
 * The ceiling an operation may not cross, in milliseconds.
 *
 * FIVE SECONDS because that is the number #9789 was filed against and the one
 * an agent's own timeout is usually set near -- past it, a caller gives up
 * rather than waits. Loose on purpose: one sample per operation cannot tell a
 * slow query from a cold start, so a tight budget would report weather.
 */
const BUDGET_MS = Number(process.env.LATENCY_BUDGET_MS ?? 5000);

/**
 * How far under budget an operation must come in before its DECLARED entry is
 * called stale, as a fraction of the budget.
 *
 * The "a stale entry FAILS" idiom is what stops an exemption list growing
 * quietly, and every other gate in this repo uses it unconditionally because
 * every other gate is DETERMINISTIC. Latency is not. An operation declared at
 * 5306ms that happens to answer in 4900ms tomorrow is the same operation, and
 * failing the run for it would report weather -- the exact thing the loose
 * budget above exists to avoid, reintroduced through the back door.
 *
 * So the list still cannot hold an entry that stopped being true, but "stopped
 * being true" means comfortably under rather than a millisecond under. A
 * genuinely fixed operation lands far below the line; a borderline one does
 * not flap.
 */
const STALE_MARGIN = 0.5;

/**
 * Reads known to exceed the budget, each with the issue that owns it.
 *
 * KEYED BY THE READ, not by (surface, operation) -- see `family()` below for
 * why. The previous list was keyed per surface and held 30 entries that are
 * 15 reads; re-scoring the recorded 2026-08-10 run under this keying turned
 * 12 over-budget operations into 5 undeclared reads and 3 "stale" entries
 * into 0, because every one of those three had a sibling surface still over
 * the line in the same sweep.
 *
 * The list must SHRINK: an entry whose read now answers well under budget on
 * EVERY surface (see STALE_MARGIN) fails this script, so a fix cannot leave a
 * stale exemption behind -- the same idiom the MCP input-parity, vocabulary
 * and cross-surface gates use.
 *
 * SEEDED FROM A REAL RUN, 2026-08-10, not from reading the code. Each entry
 * records the worst surface and the full spread, so the next reader can see
 * both how slow the read is and how much the three surfaces disagree -- the
 * spread is the evidence that one sample per surface is noise around one
 * underlying cost, not three independent measurements.
 *
 * All 20 belong to #10312, and they are not 20 independent problems: the
 * account family and the extrinsics/chain-event reads are the lakehouse
 * access path (#9789), one root cause wearing most of these hats.
 */
const DECLARED: Record<string, string> = {
  "/api/v1/accounts/{ss58}":
    "#10312 -- 8832ms worst of 3 surface(s) on 2026-08-10 (graphql 8832ms, mcp 5717ms, rest 5205ms)",
  "/api/v1/accounts/{ss58}/counterparties":
    "#10312 -- 11541ms worst of 3 surface(s) on 2026-08-10 (rest 11541ms, mcp 7921ms, graphql 6753ms)",
  "/api/v1/accounts/{ss58}/events":
    "#10312 -- 6939ms worst of 3 surface(s) on 2026-08-10 (graphql 6939ms, mcp 5683ms, rest 4848ms)",
  "/api/v1/accounts/{ss58}/extrinsics":
    "#10312 -- 8711ms worst of 3 surface(s) on 2026-08-10 (graphql 8711ms, rest 5753ms, mcp 4452ms)",
  "/api/v1/accounts/{ss58}/history":
    "#10312 -- 7442ms worst of 3 surface(s) on 2026-08-10 (mcp 7442ms, rest 6788ms, graphql 6444ms)",
  "/api/v1/accounts/{ss58}/stake-flow":
    "#10312 -- 5196ms worst of 3 surface(s) on 2026-08-10 (graphql 5196ms, rest 4260ms, mcp 2927ms)",
  "/api/v1/accounts/{ss58}/transfers":
    "#10312 -- 7568ms worst of 3 surface(s) on 2026-08-10 (rest 7568ms, graphql 6709ms, mcp 6264ms)",
  "/api/v1/accounts/{ss58}/weight-setters":
    "#10312 -- 8366ms worst of 3 surface(s) on 2026-08-10 (rest 8366ms, graphql 1878ms, mcp 1600ms)",
  "/api/v1/blocks/{ref}/extrinsics":
    "#10312 -- 12789ms worst of 3 surface(s) on 2026-08-10 (graphql 12789ms, rest 1611ms, mcp 743ms)",
  "/api/v1/extrinsics":
    "#10312 -- 11320ms worst of 3 surface(s) on 2026-08-10 (mcp 11320ms, graphql 6413ms, rest 4897ms)",
  "/api/v1/governance/config-changes":
    "#10312 -- 11201ms worst of 3 surface(s) on 2026-08-10 (graphql 11201ms, rest 7767ms, mcp 3648ms)",
  "/api/v1/subnets/{netuid}/event-summary":
    "#10312 -- 3831ms worst of 3 surface(s) on 2026-08-10 (mcp 3831ms, graphql 3368ms, rest 3235ms)",
  "/api/v1/subnets/{netuid}/events":
    "#10312 -- 3683ms worst of 3 surface(s) on 2026-08-10 (graphql 3683ms, mcp 3283ms, rest 3243ms)",
  "/api/v1/subnets/{netuid}/ohlc":
    "#10312 -- 6159ms worst of 3 surface(s) on 2026-08-10 (rest 6159ms, mcp 5931ms, graphql 4755ms)",
  "/api/v1/subnets/{netuid}/ownership-history":
    "#10312 -- 6498ms worst of 3 surface(s) on 2026-08-10 (mcp 6498ms, rest 4655ms, graphql 4349ms)",
  "/api/v1/subnets/{netuid}/registrations":
    "#10312 -- 5775ms worst of 3 surface(s) on 2026-08-10 (mcp 5775ms, graphql 2287ms, rest 2196ms)",
  "/api/v1/subnets/{netuid}/stake-moves":
    "#10312 -- 8383ms worst of 3 surface(s) on 2026-08-10 (mcp 8383ms, graphql 1634ms, rest 1418ms)",
  "/api/v1/subnets/{netuid}/weights/setters":
    "#10312 -- 3827ms worst of 3 surface(s) on 2026-08-10 (rest 3827ms, mcp 2355ms, graphql 1485ms)",
  "/api/v1/sudo":
    "#10312 -- 5408ms worst of 3 surface(s) on 2026-08-10 (graphql 5408ms, rest 5025ms, mcp 1613ms)",
  "/api/v1/validators/{hotkey}/nominators":
    "#10312 -- 10364ms worst of 3 surface(s) on 2026-08-10 (graphql 10364ms, rest 6164ms, mcp 5035ms)",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What came back, in the only three categories a latency sweep can act on.
 *
 * `unaskable` is the one worth explaining. The first full run reported 24
 * operations as "did not answer", and the two spot-checked were both THIS
 * SWEEP'S fault: `/api/v1/ask` is POST-only and answered 405, and
 * `/api/v1/providers/{slug}` 404'd because the subject was not a real provider
 * id. A sweep whose failure list is mostly its own bad questions trains the
 * reader to ignore the list -- so a 4xx, which is the server saying the REQUEST
 * was wrong, is separated from a 5xx/timeout, which is the server failing to
 * answer a fair one. Only the second is the operation's problem.
 */
type Answer = "ok" | "unaskable" | "failed";

export interface Timing {
  surface: "rest" | "mcp" | "graphql";
  operation: string;
  ms: number;
  answer: Answer;
}

export interface LatencyReport {
  timings: Timing[];
  overBudget: Timing[];
  failed: Timing[];
  /** Calls the sweep could not pose properly -- its problem, not the API's. */
  unaskable: Timing[];
  stale: string[];
}

export const key = (timing: Pick<Timing, "surface" | "operation">): string =>
  `${timing.surface}:${timing.operation}`;

/** GraphQL field -> the route it mirrors, from the same table the SDL is built from. */
const FIELD_ROUTES = new Map(
  QUERY_BINDINGS.map((binding) => [binding.field, binding.route]),
);

/**
 * The READ behind an operation -- what latency is actually a property of.
 *
 * One read is published on up to three surfaces, and this sweep takes ONE
 * sample of each. Those three samples are three noisy draws of one underlying
 * cost, not three independent measurements, so keying the ledger by
 * `surface:operation` makes the exemption list churn on which surface happened
 * to be slow that morning. Measured, on the recorded 2026-08-10 run scored
 * against the list seeded one day earlier:
 *
 *   - all 12 over-budget operations were new, and 7 of them were another
 *     surface's instance of a read already declared;
 *   - 3 entries read as STALE while a sibling surface of the same read was
 *     over the line in the same sweep. `/api/v1/sudo` is the clean case:
 *     mcp 1613ms (stale -> "delete the entry"), rest 5025ms and graphql
 *     5408ms (over budget). Deleting that declaration would have been the
 *     ledger instructing us to forget a read that is still slow.
 *
 * Keyed by the read instead, the same run scores 15 declared families, 5
 * undeclared, and 0 stale.
 *
 * DERIVED, never hand-listed: REST names its own route, MCP tools carry
 * `MCP_TOOL_ROUTES` and GraphQL fields carry `QUERY_BINDINGS` -- the two maps
 * the input-parity and SDL gates already read, so a tool or field that changes
 * which route it mirrors moves here with it.
 *
 * When a surface's operation mirrors no route -- a tool that composes several
 * reads, a field that reads a static artifact -- it falls back to
 * `surface:operation`. That is not a gap: an operation with no shared read has
 * no siblings to be confused with, so per-surface keying is already correct
 * for it.
 */
export function family(timing: Pick<Timing, "surface" | "operation">): string {
  if (timing.surface === "rest") return timing.operation;
  const route =
    timing.surface === "mcp"
      ? MCP_TOOL_ROUTES[timing.operation]?.route
      : FIELD_ROUTES.get(timing.operation);
  return route ?? key(timing);
}

/** A 4xx says the question was wrong; anything else here is the answer's fault. */
const classify = (status: number): Answer =>
  status >= 200 && status < 300
    ? "ok"
    : status >= 400 && status < 500
      ? "unaskable"
      : "failed";

async function timed(run: () => Promise<Answer>): Promise<[number, Answer]> {
  const started = Date.now();
  let answer: Answer;
  try {
    answer = await run();
  } catch {
    // A throw is a call that did not answer at all -- a timeout or a dropped
    // connection, which is the operation's problem however it is spelled.
    answer = "failed";
  }
  return [Date.now() - started, answer];
}

function withTimeout(): [AbortSignal, () => void] {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return [controller.signal, () => clearTimeout(timer)];
}

async function timeRest(path: string): Promise<[number, Answer]> {
  return timed(async () => {
    const [signal, done] = withTimeout();
    try {
      const res = await fetch(`${REST_ORIGIN}${path}`, { signal });
      // Drain the body: a route is not "done" until its bytes are, and the
      // biggest answers here are the whole point (#10318 was 486 KB).
      await res.arrayBuffer();
      return classify(res.status);
    } finally {
      done();
    }
  });
}

/**
 * MCP error codes that mean the ARGUMENTS were wrong rather than the tool.
 *
 * An MCP failure is a 200 with `isError`, so HTTP status cannot make this
 * distinction the way it can for REST -- the code in the body is the only
 * signal, and these are the two the dispatcher raises for a question it cannot
 * accept (`src/mcp-server.ts`'s `toolError("invalid_params", ...)` and the
 * not-found path behind it).
 */
const UNASKABLE_MCP_CODES = new Set(["invalid_params", "not_found"]);

let rpcId = 0;
async function timeMcp(name: string, args: Row): Promise<[number, Answer]> {
  return timed(async () => {
    const [signal, done] = withTimeout();
    try {
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
      if (!res.ok) return classify(res.status);
      const body = (await res.json()) as Row;
      const result = body?.result as Row | undefined;
      if (!result) return "failed";
      if (!result.isError) return "ok";
      const structured = (result.structuredContent ?? {}) as Row;
      const code = String((structured.error as Row | undefined)?.code ?? "");
      return UNASKABLE_MCP_CODES.has(code) ? "unaskable" : "failed";
    } finally {
      done();
    }
  });
}

async function timeGraphql(plan: FieldPlan): Promise<[number, Answer]> {
  return timed(async () => {
    const [signal, done] = withTimeout();
    try {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: plan.query }),
        signal,
      });
      if (!res.ok) return classify(res.status);
      const body = (await res.json()) as Row;
      if (body?.data) return "ok";
      // A GraphQL error with BAD_USER_INPUT is this sweep's argument fixture
      // being wrong, the same class as a REST 400.
      const errors = (body?.errors ?? []) as Row[];
      const badInput = errors.some(
        (error) =>
          ((error?.extensions ?? {}) as Row).code === "BAD_USER_INPUT" ||
          ((error?.extensions ?? {}) as Row).code ===
            "GRAPHQL_VALIDATION_FAILED",
      );
      return badInput ? "unaskable" : "failed";
    } finally {
      done();
    }
  });
}

/** Every tool the live server advertises, following tools/list pagination. */
async function listLiveTools(): Promise<{ name: string; args: Row }[]> {
  const tools: { name: string; args: Row }[] = [];
  let cursor: string | undefined;
  do {
    const [signal, done] = withTimeout();
    let body: Row;
    try {
      const res = await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: (rpcId += 1),
          method: "tools/list",
          params: cursor ? { cursor } : {},
        }),
        signal,
      });
      body = (await res.json()) as Row;
    } finally {
      done();
    }
    const result = (body?.result ?? {}) as Row;
    for (const tool of (result.tools ?? []) as Row[]) {
      const schema = (tool.inputSchema ?? {}) as Row;
      const args = argumentsForRequired((schema.required ?? []) as string[]);
      if (args) tools.push({ name: String(tool.name), args });
    }
    cursor = result.nextCursor as string | undefined;
    if (cursor) await sleep(CALL_SPACING_MS);
  } while (cursor);
  return tools;
}

export async function run(): Promise<LatencyReport> {
  const timings: Timing[] = [];

  for (const route of [...API_ROUTES, ...FEED_ROUTES]) {
    // GET only. `/api/v1/ask` is the one POST route in the table, and asking it
    // with a GET times a 405 -- the sweep measuring its own wrong verb.
    if (route.method !== "GET") continue;
    const path = concreteRoute(route.path);
    if (path === null) continue;
    const [ms, answer] = await timeRest(path);
    timings.push({ surface: "rest", operation: route.path, ms, answer });
    process.stderr.write(`rest ${ms}ms ${answer} ${route.path}\n`);
    await sleep(CALL_SPACING_MS);
  }

  for (const tool of await listLiveTools()) {
    const [ms, answer] = await timeMcp(tool.name, tool.args);
    timings.push({ surface: "mcp", operation: tool.name, ms, answer });
    process.stderr.write(`mcp ${ms}ms ${answer} ${tool.name}\n`);
    await sleep(CALL_SPACING_MS);
  }

  const { plans } = planAll(buildSchema(SDL));
  for (const plan of plans) {
    const [ms, answer] = await timeGraphql(plan);
    timings.push({ surface: "graphql", operation: plan.field, ms, answer });
    process.stderr.write(`graphql ${ms}ms ${answer} ${plan.field}\n`);
    await sleep(CALL_SPACING_MS);
  }

  return summarise(timings);
}

/** The verdict, split out so a recorded run can be re-scored without calling. */
export function summarise(timings: Timing[]): LatencyReport {
  const overBudget = timings.filter(
    (timing) =>
      timing.answer === "ok" &&
      timing.ms > BUDGET_MS &&
      !DECLARED[family(timing)],
  );
  // An entry stays warranted while its read is still anywhere near the line ON
  // ANY SURFACE, and an operation this run could not ASK keeps its entry too --
  // a 4xx from a bad subject is not evidence the read got faster.
  //
  // "any surface" is the half that per-operation keying got wrong: a read is
  // only fixed when every surface serving it comes in comfortably under, and
  // one fast draw out of three is noise, not a fix.
  const stillSlow = new Set(
    timings
      .filter(
        (timing) =>
          timing.answer !== "ok" || timing.ms > BUDGET_MS * STALE_MARGIN,
      )
      .map(family)
      .filter((name) => DECLARED[name]),
  );
  return {
    timings,
    overBudget,
    // A FAILED call is not a slow one, and mixing them would bury both -- the
    // conformance sweeps are what report an operation that declines.
    failed: timings.filter((timing) => timing.answer === "failed"),
    unaskable: timings.filter((timing) => timing.answer === "unaskable"),
    stale: Object.keys(DECLARED).filter((name) => !stillSlow.has(name)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

export function formatReport(report: LatencyReport): string {
  const lines: string[] = [];
  for (const surface of ["rest", "mcp", "graphql"] as const) {
    const ms = report.timings
      .filter((timing) => timing.surface === surface && timing.answer === "ok")
      .map((timing) => timing.ms)
      .sort((a, b) => a - b);
    if (ms.length === 0) continue;
    lines.push(
      `${surface}: ${ms.length} timed, p50 ${percentile(ms, 50)}ms, ` +
        `p90 ${percentile(ms, 90)}ms, p99 ${percentile(ms, 99)}ms, max ${ms[ms.length - 1]}ms`,
    );
  }
  const slowest = [...report.timings]
    .filter((timing) => timing.answer === "ok")
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15);
  lines.push("", "slowest 15:");
  for (const timing of slowest) {
    lines.push(
      `  ${String(timing.ms).padStart(6)}ms  ${timing.surface}  ${timing.operation}`,
    );
  }
  if (report.failed.length > 0) {
    lines.push("", `${report.failed.length} operation(s) did not answer:`);
    for (const timing of report.failed.slice(0, 30)) {
      lines.push(`  ${timing.surface}  ${timing.operation}`);
    }
  }
  if (report.unaskable.length > 0) {
    lines.push(
      "",
      `${report.unaskable.length} could not be asked (4xx -- this sweep's subject or arguments, not the operation):`,
    );
    for (const timing of report.unaskable.slice(0, 30)) {
      lines.push(`  ${timing.surface}  ${timing.operation}`);
    }
  }
  if (report.overBudget.length > 0) {
    // Grouped by read, because that is the unit a declaration is written in --
    // printing twelve lines for five reads is what made the previous list get
    // seeded three times over.
    const byFamily = new Map<string, Timing[]>();
    for (const timing of report.overBudget) {
      const name = family(timing);
      const group = byFamily.get(name) ?? [];
      group.push(timing);
      byFamily.set(name, group);
    }
    lines.push(
      "",
      `${report.overBudget.length} call(s) over the ${BUDGET_MS}ms budget, across ${byFamily.size} undeclared read(s):`,
    );
    for (const [name, group] of byFamily) {
      const worst = Math.max(...group.map((timing) => timing.ms));
      const spread = group
        .sort((a, b) => b.ms - a.ms)
        .map((timing) => `${timing.surface} ${timing.ms}ms`)
        .join(", ");
      lines.push(`  ${worst}ms  ${name}  (${spread})`);
    }
  }
  if (report.stale.length > 0) {
    lines.push(
      "",
      `${report.stale.length} stale DECLARED entr(y/ies) -- now comfortably under budget, delete them:`,
    );
    for (const name of report.stale) lines.push(`  ${name}`);
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await run();
  console.log(formatReport(report));
  if (report.overBudget.length > 0 || report.stale.length > 0) process.exit(1);
}
