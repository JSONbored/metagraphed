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
import { API_ROUTES, FEED_ROUTES } from "../src/contracts.ts";
import { SDL } from "../src/graphql-sdl.ts";
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
 * Operations known to exceed the budget, each with the issue that owns it.
 *
 * The list must SHRINK: an entry whose operation now answers well under budget
 * (see STALE_MARGIN) fails this script, so a fix cannot leave a stale exemption
 * behind -- the same idiom the MCP input-parity, vocabulary and cross-surface
 * gates use.
 *
 * SEEDED FROM A REAL RUN, 2026-08-09, not from reading the code, and the
 * milliseconds are recorded so the next reader can see whether an entry is
 * drifting rather than merely present. All 30 belong to #10312, and they are
 * not 30 independent problems: 21 of them are the ACCOUNT family and its
 * mirrors on the other two surfaces -- the same read, timed three times.
 */
const DECLARED: Record<string, string> = {
  "graphql:account_transfers":
    "#10312 -- 12590ms on the run that seeded this list",
  "graphql:account_counterparties":
    "#10312 -- 11986ms on the run that seeded this list",
  "graphql:account_history":
    "#10312 -- 10227ms on the run that seeded this list",
  "graphql:validator_nominators":
    "#10312 -- 8348ms on the run that seeded this list",
  "graphql:account_extrinsics":
    "#10312 -- 6822ms on the run that seeded this list",
  "graphql:account_events": "#10312 -- 6122ms on the run that seeded this list",
  "graphql:subnet_weight_setters":
    "#10312 -- 5306ms on the run that seeded this list",
  "mcp:get_account_counterparties":
    "#10312 -- 15416ms on the run that seeded this list",
  "mcp:get_account_history":
    "#10312 -- 11670ms on the run that seeded this list",
  "mcp:get_account_transfers":
    "#10312 -- 9877ms on the run that seeded this list",
  "mcp:get_subnet_weight_setters":
    "#10312 -- 7760ms on the run that seeded this list",
  "mcp:get_account": "#10312 -- 7481ms on the run that seeded this list",
  "mcp:get_validator_nominators":
    "#10312 -- 7299ms on the run that seeded this list",
  "mcp:get_subnet_ownership_history":
    "#10312 -- 7231ms on the run that seeded this list",
  "mcp:get_sudo": "#10312 -- 6973ms on the run that seeded this list",
  "mcp:get_account_stake_flow":
    "#10312 -- 5907ms on the run that seeded this list",
  "mcp:get_account_events": "#10312 -- 5512ms on the run that seeded this list",
  "mcp:get_subnet_events": "#10312 -- 5295ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/transfers":
    "#10312 -- 11101ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/history":
    "#10312 -- 9038ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}":
    "#10312 -- 7855ms on the run that seeded this list",
  "rest:/api/v1/subnets/{netuid}/event-summary":
    "#10312 -- 7798ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/extrinsics":
    "#10312 -- 7464ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/counterparties":
    "#10312 -- 6760ms on the run that seeded this list",
  "rest:/api/v1/subnets/{netuid}/events":
    "#10312 -- 6700ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/events":
    "#10312 -- 6548ms on the run that seeded this list",
  "rest:/api/v1/subnets/{netuid}/ohlc":
    "#10312 -- 6428ms on the run that seeded this list",
  "rest:/api/v1/accounts/{ss58}/weight-setters":
    "#10312 -- 6366ms on the run that seeded this list",
  "rest:/api/v1/validators/{hotkey}/nominators":
    "#10312 -- 6095ms on the run that seeded this list",
  "rest:/api/v1/subnets/{netuid}/ownership-history":
    "#10312 -- 5642ms on the run that seeded this list",
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
      timing.answer === "ok" && timing.ms > BUDGET_MS && !DECLARED[key(timing)],
  );
  // An entry stays warranted while its operation is still anywhere near the
  // line, and an operation this run could not ASK keeps its entry too -- a 4xx
  // from a bad subject is not evidence the operation got faster.
  const stillSlow = new Set(
    timings
      .filter(
        (timing) =>
          timing.answer !== "ok" || timing.ms > BUDGET_MS * STALE_MARGIN,
      )
      .map(key)
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
    lines.push(
      "",
      `${report.overBudget.length} over the ${BUDGET_MS}ms budget:`,
    );
    for (const timing of report.overBudget) {
      lines.push(`  ${timing.ms}ms  ${timing.surface}  ${timing.operation}`);
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
