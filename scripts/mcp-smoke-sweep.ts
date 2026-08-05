// Live smoke sweep across every registered MCP tool (#9455).
//
// Enumerates tools from the server's own `tools/list`, builds arguments for each
// tool from its own `inputSchema.required` against a fixture map, calls it, and
// reports the shape of what came back. It exists to catch the class of defect
// hand-testing misses: a published field that can never carry a value, or a
// snapshot far older than its tool implies.
//
// THE OUTPUT IS A TRIAGE LIST, NOT A VERDICT. The EMPTY / ALL_NULL / UNIFORM
// heuristic is deliberately noisy, because a quiet heuristic would miss the
// bugs this is for. `UNIFORM(netuid)` on a tool you filtered BY netuid is
// expected, not a finding; so is `ALL_NULL` on a field that is genuinely null
// for the one fixture account. Every SUSPECT line has to be confirmed by hand
// against the tool's contract before it becomes a bug report -- during the
// original sweep, two flags were written up as defects before that step and
// were wrong. For the same reason a SUSPECT flag NEVER fails this script: only
// a transport failure sets a non-zero exit code.
//
// Not wired into CI: one run makes ~215 live production calls. It is an
// explicit, opt-in invocation (`npm run smoke:mcp`), never something a PR
// triggers.
//
// A known limit of driving the sweep off `required`: a handful of tools
// (how_do_i_call, verify_integration) declare no required field but reject an
// empty argument set, because their real contract is "one of these two". They
// report ERROR with that message rather than OK, which is honest -- covering
// them would mean hand-maintaining the per-tool argument table this design
// exists to avoid.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagValue } from "./lib.ts";

// Live MCP JSON-RPC payloads. Every field below is read for reporting only, and
// an unexpected shape is exactly what this sweep exists to surface -- typing
// each hop through `unknown` would force a cast at every `?.` for no real
// safety gain. Mirrors the `Row` precedent in smoke-live-api.ts and lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const DEFAULT_ENDPOINT = "https://api.metagraph.sh/mcp";
const DEFAULT_TIMEOUT_MS = 30000;
// Serial by default, and that is not conservatism for its own sake: the
// endpoint rate-limits per client, and a first pass at concurrency 2 turned 34
// healthy tools into `-32600 Too many MCP requests` -- a parallel sweep
// manufacturing failures that read exactly like real defects. Raise it only if
// you are prepared to re-confirm every error serially.
const DEFAULT_CONCURRENCY = 1;
// A rate-limited call is not a result, so it is retried rather than reported.
// Without this the sweep's error list silently mixes "this tool is broken" with
// "we asked too fast", which is the one thing a triage list must not do.
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 1000;
// A field only reads as suspiciously UNIFORM once there are enough rows for
// "every row is identical" to mean something. Below this, one shared value is
// unremarkable.
const UNIFORM_MIN_ROWS = 5;

// Declared up here, not next to postRpc: the direct-execution guard below runs
// `main()` at module top level, which would hit this in its temporal dead zone
// if it were declared further down the file.
let rpcId = 0;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Argument values keyed by the required-field name a tool declares, plus
// `"<tool>.<field>"` overrides that win over the bare name. The overrides are
// load-bearing: `slug` means a provider slug to get_provider_detail and an
// adapter slug to get_adapter, and a single flat map silently sends the wrong
// one (that mismatch produced most of the original sweep's errors).
//
// Deliberately ABSENT, so their tools report UNTESTED rather than being called
// with an invented value:
//   - `credential` (store_surface_credential) -- writes a credential.
//   - `owner_token` (get_alert_trigger) -- a real secret; there is no safe value.
//   - `method` (call_rpc) -- proxies an arbitrary chain RPC call.
//   - `to` / `input` (decode_evm_call) -- needs a real contract + calldata pair.
//   - `id` (get_webhook_subscription) -- a UUID v4 for a subscription that must
//     already exist; a fabricated one is correctly rejected, which tells us
//     nothing.
// UNTESTED is the point: a tool added later with a required field this map
// lacks shows up in the summary instead of vanishing from coverage.
export function buildFixtures(now: Date = new Date()): Record<string, unknown> {
  return {
    netuid: 64,
    netuids: [7, 8],
    uid: 0,
    // Top-of-leaderboard coldkey -- an account with balance, stake positions and
    // history, so account tools return populated rows rather than a valid-but-
    // empty account.
    ss58: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    hotkey: "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
    hotkeys: ["5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"],
    // A block well below head: old enough to be durably indexed across every
    // tier, and `blocks` is complete from genesis so it never ages out.
    ref: "8700000",
    block_number: 8700000,
    amount: 1,
    query: "inference",
    capability: "inference",
    task: "generate images from a text prompt",
    question: "Which subnets expose a public API?",
    kind: "registry",
    query_id: "subnet-leaderboard",
    slug: "404-gen",
    surface_id: "allways-api-health",
    h160: "0x0000000000000000000000000000000000000001",
    // Health history is sparse and the current day's snapshot may not have
    // landed yet, so anchor a day back rather than on today.
    date: isoDate(new Date(now.getTime() - 86400000)),

    // Per-tool overrides.
    "get_adapter.slug": "allways",
    // `ref` is polymorphic: a block ref to get_block, but a composite
    // "<block>-<extrinsic_index>" to the extrinsic tools. Sent the block ref,
    // get_extrinsic returns an empty row set and the heuristic flags a
    // perfectly healthy tool EMPTY -- a fixture bug wearing a defect's clothes.
    "get_extrinsic.ref": "8700000-3",
    "get_extrinsic_chain_events.ref": "8700000-3",
    // `query` is a search term everywhere except here, where it is GraphQL.
    "query_graphql.query": "{ subnets(limit: 2) { items { netuid name } } }",
    // get_api_schema resolves a *captured schema*, which only openapi-kind
    // surfaces have -- the generic surface fixture is a plain API surface and
    // correctly 404s here.
    "get_api_schema.surface_id": "sn-1-apex-orchestrator-openapi",
  };
}

// A `"<tool>.<field>"` fixture wins over the bare `"<field>"` one. Returns the
// miss explicitly rather than `undefined`, so a fixture deliberately set to
// null/0/"" stays distinguishable from one that was never defined.
export function resolveFixture(
  toolName: string,
  field: string,
  fixtures: Record<string, unknown>,
): { found: boolean; value?: unknown } {
  const scoped = `${toolName}.${field}`;
  if (Object.hasOwn(fixtures, scoped)) {
    return { found: true, value: fixtures[scoped] };
  }
  if (Object.hasOwn(fixtures, field)) {
    return { found: true, value: fixtures[field] };
  }
  return { found: false };
}

export type ToolArguments =
  { status: "ready"; args: Row } | { status: "untested"; missing: string[] };

// Builds a call payload from the tool's OWN declared `required` list, never a
// hand-maintained per-tool argument table -- that is what keeps the sweep
// honest as tools are added. Only required fields are sent: an optional field
// left unset exercises the tool's real defaults, which is what a caller gets.
export function buildToolArguments(
  tool: Row,
  fixtures: Record<string, unknown>,
): ToolArguments {
  const required = tool?.inputSchema?.required;
  const fields = Array.isArray(required) ? required : [];
  const args: Row = {};
  const missing: string[] = [];
  for (const field of fields) {
    const fixture = resolveFixture(tool?.name, field, fixtures);
    if (fixture.found) {
      args[field] = fixture.value;
    } else {
      missing.push(field);
    }
  }
  return missing.length > 0
    ? { status: "untested", missing }
    : { status: "ready", args };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// The endpoint answers either a plain JSON body or an SSE stream, depending on
// what it negotiates for the request. For SSE, the JSON-RPC payload is the last
// `data:` line -- earlier ones can be keepalives or progress notifications.
export function parseMcpPayload(text: string): Row {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty response body");
  }
  if (!/^(event|id|retry|data)\s*:/m.test(trimmed)) {
    return JSON.parse(trimmed) as Row;
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  const last = dataLines.at(-1);
  if (!last) {
    throw new Error("SSE response carried no data: line");
  }
  return JSON.parse(last) as Row;
}

// A throttle response, not a defect: the endpoint rate-limits per client, and
// the refusal arrives as a generic JSON-RPC -32600 whose *message* is the only
// thing distinguishing it from a genuine bad request. Matched on both so a real
// -32600 still surfaces as RPCERR.
export function isRateLimited(payload: Row): boolean {
  const error = payload?.error;
  if (!error) return false;
  return (
    Number(error.code) === -32600 &&
    /too many|rate limit|slow down/i.test(String(error.message ?? ""))
  );
}

export type CallOutcome =
  | { outcome: "ok"; structured: unknown }
  | { outcome: "error"; code: string; message: string }
  | { outcome: "rpcerr"; code: string; message: string };

// Three distinct failure surfaces, kept apart because they mean different
// things: RPCERR is the JSON-RPC envelope rejecting the call (bad params, no
// such tool), ERROR is the tool itself reporting a handled failure
// (`not_found`, `auth_required`), and everything else is a real result.
export function classifyCall(payload: Row): CallOutcome {
  if (payload?.error) {
    return {
      outcome: "rpcerr",
      code: String(payload.error.code ?? "unknown"),
      message: String(payload.error.message ?? ""),
    };
  }
  const result = payload?.result;
  if (result?.isError) {
    const error = result?.structuredContent?.error;
    return {
      outcome: "error",
      code: String(error?.code ?? "unknown"),
      message: String(error?.message ?? ""),
    };
  }
  return { outcome: "ok", structured: result?.structuredContent };
}

// ---------------------------------------------------------------------------
// Shape heuristic
// ---------------------------------------------------------------------------

// Depth-first walk for the first array of objects -- the row set a caller would
// actually read. Deterministic: object keys in insertion order, and an array is
// checked before descending into it, so the outermost row set wins over a
// nested one.
export function findFirstRowArray(
  value: unknown,
  basePath = "",
): { path: string; rows: Row[] } | null {
  if (Array.isArray(value)) {
    if (value.every((item) => isPlainObject(item))) {
      return { path: basePath || "$", rows: value as Row[] };
    }
    for (const [index, item] of value.entries()) {
      const found = findFirstRowArray(item, `${basePath}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findFirstRowArray(
      child,
      basePath ? `${basePath}.${key}` : key,
    );
    if (found) return found;
  }
  return null;
}

export type RowFlag =
  | { kind: "EMPTY" }
  | { kind: "ALL_NULL"; fields: string[] }
  | { kind: "UNIFORM"; fields: string[] };

// Flags the three shapes that have actually indicated a defect here: no rows at
// all, a declared field that is null on every row, and a field frozen at one
// value across enough rows to be odd. ALL_NULL takes precedence over UNIFORM
// for the same field -- an all-null field is trivially uniform, and reporting
// it twice just makes the triage list noisier.
export function flagRows(rows: Row[]): RowFlag[] {
  if (rows.length === 0) {
    return [{ kind: "EMPTY" }];
  }
  const fields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) fields.add(key);
  }
  const allNull: string[] = [];
  const uniform: string[] = [];
  for (const field of fields) {
    const values = rows.map((row) => row[field]);
    if (values.every((value) => value === null || value === undefined)) {
      allNull.push(field);
      continue;
    }
    if (rows.length < UNIFORM_MIN_ROWS) continue;
    const first = JSON.stringify(values[0]);
    if (values.every((value) => JSON.stringify(value) === first)) {
      uniform.push(field);
    }
  }
  const flags: RowFlag[] = [];
  if (allNull.length > 0) flags.push({ kind: "ALL_NULL", fields: allNull });
  if (uniform.length > 0) flags.push({ kind: "UNIFORM", fields: uniform });
  return flags;
}

export function formatFlags(flags: RowFlag[]): string {
  return flags
    .map((flag) =>
      flag.kind === "EMPTY"
        ? "EMPTY"
        : `${flag.kind}(${flag.fields.join(",")})`,
    )
    .join(" ");
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const HELP = `Usage: npm run smoke:mcp -- [options]

Calls every tool the MCP endpoint advertises and reports the shape of each
response. Makes one live call per tool (~215 against production), so it is an
explicit opt-in run and is never wired into CI.

The SUSPECT flags are a TRIAGE LIST, not a verdict. UNIFORM(netuid) on a tool
filtered by netuid is expected; confirm every flag by hand against the tool's
contract before treating it as a defect. A flag never fails this command --
only a transport failure sets a non-zero exit code.

Options:
  --endpoint <url>     MCP endpoint (env: METAGRAPH_MCP_ENDPOINT)
                       [default: ${DEFAULT_ENDPOINT}]
  --tool <substring>   Only sweep tools whose name contains this substring
  --concurrency <n>    Parallel calls [default: ${DEFAULT_CONCURRENCY}]
  --timeout-ms <n>     Per-call timeout [default: ${DEFAULT_TIMEOUT_MS}]
  --json               Emit the full report as JSON instead of a table
  --help               Show this message
`;

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const endpoint =
    flagValue(argv, "--endpoint") ||
    process.env.METAGRAPH_MCP_ENDPOINT ||
    DEFAULT_ENDPOINT;
  const toolFilter = flagValue(argv, "--tool") || null;
  const concurrency = Math.max(
    1,
    Number(flagValue(argv, "--concurrency", String(DEFAULT_CONCURRENCY))),
  );
  const timeoutMs = Number(
    flagValue(argv, "--timeout-ms", String(DEFAULT_TIMEOUT_MS)),
  );
  const asJson = argv.includes("--json");
  const fixtures = buildFixtures();

  let tools: Row[];
  try {
    tools = await listTools(endpoint, timeoutMs);
  } catch (error) {
    console.error(
      `transport failure: tools/list against ${endpoint}: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  const selected = toolFilter
    ? tools.filter((tool) => String(tool?.name).includes(toolFilter))
    : tools;

  // Progress goes to stderr, not stdout: a serial sweep of ~215 live tools runs
  // for minutes, and a command with no output for that long is indistinguishable
  // from a hung one. Keeping it off stdout leaves the report itself pipeable.
  let completed = 0;
  const results = await mapWithConcurrency(
    selected,
    concurrency,
    async (tool) => {
      const result = await sweepTool(endpoint, tool, fixtures, timeoutMs);
      completed += 1;
      process.stderr.write(
        `\r[${completed}/${selected.length}] ${result.status} ${result.tool}`.padEnd(
          78,
        ),
      );
      return result;
    },
  );
  process.stderr.write("\n");

  const summary = {
    endpoint,
    swept_at: new Date().toISOString(),
    // Kept apart so a filtered run stays readable: `advertised` is what
    // tools/list returned, `total` is what this invocation actually called.
    advertised: tools.length,
    total: selected.length,
    ok: results.filter((r) => r.status === "OK").length,
    errored: results.filter(
      (r) => r.status === "ERROR" || r.status === "RPCERR",
    ).length,
    untested: results.filter((r) => r.status === "UNTESTED").length,
    transport_failures: results.filter((r) => r.status === "TRANSPORT").length,
    suspect: results.filter((r) => r.flags.length > 0).length,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    for (const result of results) {
      const detail =
        result.status === "OK"
          ? `rows=${result.row_count ?? "-"} path=${result.row_path ?? "-"}`
          : result.detail;
      const suspect =
        result.flags.length > 0 ? `  SUSPECT ${formatFlags(result.flags)}` : "";
      console.log(
        `${result.status.padEnd(9)} ${String(result.tool).padEnd(38)} ${detail}${suspect}`,
      );
    }
    const scope =
      summary.total === summary.advertised
        ? `total=${summary.total}`
        : `total=${summary.total} of ${summary.advertised} advertised`;
    console.log(
      `\n# summary: ok=${summary.ok} errored=${summary.errored} ` +
        `untestable=${summary.untested} ${scope} suspect=${summary.suspect}`,
    );
    console.log(
      "# SUSPECT flags are a triage list, not a verdict -- confirm each " +
        "against the tool's contract before filing anything.",
    );
  }

  // A noisy heuristic must never be able to red-line anything: only a failure
  // to actually reach the endpoint is an error condition here.
  if (summary.transport_failures > 0) {
    console.error(
      `transport failures on ${summary.transport_failures} tool(s)`,
    );
    process.exitCode = 1;
  }
}

type SweepResult = {
  tool: string;
  status: "OK" | "ERROR" | "RPCERR" | "UNTESTED" | "TRANSPORT";
  detail: string;
  flags: RowFlag[];
  row_count?: number;
  row_path?: string;
};

async function sweepTool(
  endpoint: string,
  tool: Row,
  fixtures: Record<string, unknown>,
  timeoutMs: number,
): Promise<SweepResult> {
  const name = String(tool?.name);
  const built = buildToolArguments(tool, fixtures);
  if (built.status === "untested") {
    return {
      tool: name,
      status: "UNTESTED",
      detail: `no fixture for required: ${built.missing.join(", ")}`,
      flags: [],
    };
  }

  let payload: Row;
  try {
    payload = await postRpc(
      endpoint,
      { method: "tools/call", params: { name, arguments: built.args } },
      timeoutMs,
    );
  } catch (error) {
    return {
      tool: name,
      status: "TRANSPORT",
      detail: String(error),
      flags: [],
    };
  }

  const classified = classifyCall(payload);
  if (classified.outcome !== "ok") {
    return {
      tool: name,
      status: classified.outcome === "rpcerr" ? "RPCERR" : "ERROR",
      detail: `${classified.code}: ${classified.message}`,
      flags: [],
    };
  }

  const found = findFirstRowArray(classified.structured);
  if (!found) {
    return { tool: name, status: "OK", detail: "no row array", flags: [] };
  }
  return {
    tool: name,
    status: "OK",
    detail: "",
    flags: flagRows(found.rows),
    row_count: found.rows.length,
    row_path: found.path,
  };
}

async function listTools(endpoint: string, timeoutMs: number): Promise<Row[]> {
  const payload = await postRpc(endpoint, { method: "tools/list" }, timeoutMs);
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list did not return a tools array");
  }
  return tools as Row[];
}

// Retries a throttled call with linear backoff instead of reporting it. After
// the last attempt the rate-limit payload is returned as-is, so a genuinely
// exhausted budget still shows up as RPCERR rather than passing silently.
async function postRpc(
  endpoint: string,
  body: { method: string; params?: Row },
  timeoutMs: number,
): Promise<Row> {
  let payload: Row = {};
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    payload = await postRpcOnce(endpoint, body, timeoutMs);
    if (!isRateLimited(payload)) return payload;
    if (attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
    }
  }
  return payload;
}

async function postRpcOnce(
  endpoint: string,
  body: { method: string; params?: Row },
  timeoutMs: number,
): Promise<Row> {
  rpcId += 1;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok && !text.trim()) {
    throw new Error(`HTTP ${response.status} with empty body`);
  }
  return parseMcpPayload(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fixed-size worker pool that preserves input order in the output, so the
// report reads in tools/list order regardless of which call finished first.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  return results;
}
