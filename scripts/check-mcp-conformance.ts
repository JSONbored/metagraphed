// Do the MCP responses we SERVE match the outputSchemas we PUBLISH? (#9879)
//
// The REST half of this question has been answered out of band since #9141
// (scripts/check-response-conformance.ts, scheduled daily). The MCP half was
// not answered anywhere. `validate:mcp` runs in CI against a hermetic harness
// and reports, honestly, that it cannot finish the job:
//
//   MCP response coverage: 209/225 tools validated against a real response;
//   97 validated over empty collections, so their item shapes rely on the
//   production sweep.
//
// That sweep (scripts/mcp-smoke-sweep.ts) was never scheduled anywhere. So CI
// said "something else checks these" and nothing did -- an unexercised check
// reporting success, which is the exact failure the coverage line was written
// to avoid.
//
// WHAT THIS CATCHES THAT THE HERMETIC GATE CANNOT. A tool answering
// `{items: []}` satisfies its outputSchema completely: every declared property
// of `items[]` is vacuously fine because there are no items. Only production
// has the rows. #9884 is the worked example -- deriving MCP schemas from route
// schemas made row objects strict, and 25 tools began failing their own
// published schema the moment a caller used the `fields` parameter they
// advertise. CI stayed green throughout, because the harness serves no rows to
// project.
//
// SO THE PROJECTED PATH IS SWEPT TOO, not just the plain one. Each
// `fields`-capable tool is called twice: once whole, then again projected onto
// a field name taken off its own first response.
//
// A SCHEMA VIOLATION FAILS THIS CHECK. That is the difference between this and
// mcp-smoke-sweep.ts, which is a deliberately noisy TRIAGE list where a SUSPECT
// flag never fails. "The response does not match the schema we publish" needs
// no judgement to confirm, so it is an error rather than a flag.
import { Ajv2020 } from "ajv/dist/2020.js";

// Live MCP JSON-RPC payloads, read for reporting. Same `Row` precedent as
// scripts/mcp-smoke-sweep.ts and scripts/lib.ts: an unexpected shape is what
// this exists to surface, so typing each hop through `unknown` would force a
// cast at every `?.` for no real safety.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

import {
  buildToolArguments,
  projectableFieldFrom,
  projectionArgumentFor,
} from "./mcp-tool-arguments.ts";
import { addAjvFormats } from "./lib/ajv-formats.ts";

const ENDPOINT =
  process.env.MCP_CONFORMANCE_ENDPOINT || "https://api.metagraph.sh/mcp";
// Serial, and spaced. The endpoint rate-limits per CLIENT, not per tool: a
// first pass at concurrency 2 turned 34 healthy tools into
// `-32600 Too many MCP requests`, a parallel sweep manufacturing failures that
// read exactly like real defects (scripts/mcp-smoke-sweep.ts records the same
// finding). ~1.6s is the measured floor.
const CALL_SPACING_MS = Number(process.env.MCP_CONFORMANCE_SPACING_MS ?? 1600);

// #11565: the shared secret that makes this sweep's probe marker believable.
// Optional on purpose -- a local run without the secret still works and simply
// is not excluded from metrics, which is the right way round.
const PROBE_TOKEN = process.env.MCP_PROBE_TOKEN?.trim() || "";
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConformanceViolation {
  tool: string;
  /** "plain" or "projected" -- which of the two calls failed. */
  call: string;
  path: string;
  message: string;
}

let rpcId = 0;

async function rpc(method: string, params: Row): Promise<Row> {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let body: Row;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          // Name this runner in the server's client analytics. Without it the
          // sweep arrives as Node's default UA and was the single largest
          // "unidentified client" in the MCP dashboard -- every probe it
          // makes, including the deliberate error-path ones, showed up as an
          // anonymous agent failing rather than as our own nightly check.
          "user-agent": "metagraphed-conformance/1",
          // #11565: and mark it FIRST-PARTY, so product metrics can exclude it.
          // The UA above identifies the runner; this says the traffic is ours.
          // The distinction matters -- a third party's `flowstacks-mcp-
          // conformance` is also a conformance checker, and its calls are real
          // usage that must stay in the numbers.
          //
          // This sweep touches all 242 tools every night, which is 4,990 tool
          // calls a month against a surface whose real interactive traffic is
          // ~1,600 -- so leaving it unlabelled does not merely add noise, it
          // dominates the per-tool caller counts pricing is chosen from.
          "x-metagraph-probe": "mcp-conformance",
          // Proof the marker above is ours. Without it the server ignores the
          // marker entirely and the sweep counts as ordinary traffic -- which
          // is the safe failure, and lets the secret and the deploy land in
          // either order.
          ...(PROBE_TOKEN ? { "x-metagraph-probe-token": PROBE_TOKEN } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: (rpcId += 1),
          method,
          params,
        }),
        signal: controller.signal,
      });
      body = (await res.json()) as Row;
    } finally {
      clearTimeout(timer);
    }
    // A rate-limited call is not a result. Retrying rather than reporting it is
    // what keeps "this tool is broken" out of the same bucket as "we asked too
    // fast" -- the one distinction a conformance report must not lose.
    const rateLimited = /Too many MCP requests/i.test(
      String(body?.error?.message ?? ""),
    );
    if (rateLimited && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      continue;
    }
    return body;
  }
}

/** Every tool the live server advertises, following tools/list pagination. */
export async function listLiveTools(): Promise<Row[]> {
  const tools: Row[] = [];
  let cursor: string | undefined;
  do {
    const body = await rpc("tools/list", cursor ? { cursor } : {});
    if (body?.error) {
      throw new Error(`tools/list failed: ${JSON.stringify(body.error)}`);
    }
    for (const tool of (body?.result?.tools ?? []) as Row[]) tools.push(tool);
    cursor = body?.result?.nextCursor as string | undefined;
    if (cursor) await sleep(CALL_SPACING_MS);
  } while (cursor);
  return tools;
}

function ajv() {
  const instance = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: true,
  });
  // Same cast as scripts/check-response-conformance.ts: ajv-formats' CJS
  // default export has no call signature under this module resolution.
  addAjvFormats(instance);
  return instance;
}

/**
 * Validate one structured result against one outputSchema.
 *
 * Exported for the unit test: the transport is the part that needs production,
 * the comparison is not, and a comparison nobody can test offline is a
 * comparison nobody checks.
 */
export function violationsFor(
  schema: Row,
  structured: unknown,
  tool: string,
  call: string,
): ConformanceViolation[] {
  const validate = ajv().compile(schema);
  if (validate(structured)) return [];
  return (validate.errors ?? []).map((error) => ({
    tool,
    call,
    path: error.instancePath || "(root)",
    message: error.message ?? "failed validation",
  }));
}

export interface ConformanceReport {
  checked: number;
  projectionChecked: number;
  projectionUnexercised: string[];
  declined: string[];
  undocumented: string[];
  violations: ConformanceViolation[];
}

/**
 * Exported so the tripwire pre-flight (#10789) sweeps production through the
 * SAME transport, spacing and rate-limit backoff this check uses. Two sweeps
 * with two call paths would differ on retries first and on results eventually.
 */
export async function callTool(name: string, args: Row): Promise<Row> {
  const body = await rpc("tools/call", { name, arguments: args });
  await sleep(CALL_SPACING_MS);
  return body;
}

/** The tool's structured result, or null when it declined. */
export function structuredOf(body: Row): Row | null {
  if (body?.error) return null;
  if (body?.result?.isError) return null;
  const structured = body?.result?.structuredContent;
  return structured && typeof structured === "object" ? structured : null;
}

export async function run(): Promise<ConformanceReport> {
  const tools = await listLiveTools();
  const report: ConformanceReport = {
    checked: 0,
    projectionChecked: 0,
    projectionUnexercised: [],
    declined: [],
    undocumented: [],
    violations: [],
  };

  for (const tool of tools) {
    const name = String(tool.name);
    const schema = tool.outputSchema as Row | undefined;
    // A tool with no published outputSchema promises nothing about its shape,
    // so there is nothing here to conform to. That is a real gap, but it is
    // #9797's gap, not a conformance failure.
    if (!schema) continue;
    const { args, undocumented } = buildToolArguments(tool.inputSchema as Row);
    if (undocumented.length > 0) {
      report.undocumented.push(`${name} (${undocumented.join(", ")})`);
      continue;
    }
    const body = await callTool(name, args);
    const structured = structuredOf(body);
    if (structured === null) {
      // A decline is not a conformance failure: production legitimately
      // answers not_found for an example subject that has since changed, and a
      // scheduled check that pages on that would be turned off within a week.
      // Reported so the count is legible rather than silently smaller.
      report.declined.push(name);
      continue;
    }
    report.checked += 1;
    report.violations.push(...violationsFor(schema, structured, name, "plain"));

    // The projected path -- the one #9884 broke while CI stayed green.
    const properties = ((tool.inputSchema as Row)?.properties ?? {}) as Row;
    if (!properties.fields) continue;
    const field = projectableFieldFrom(structured);
    if (!field) {
      // Production served no rows either, so the projection is genuinely
      // unexercisable right now. Named rather than counted, so a tool that is
      // permanently empty is visible instead of quietly absent.
      report.projectionUnexercised.push(name);
      continue;
    }
    const projected = await callTool(name, {
      ...args,
      fields: projectionArgumentFor(tool.inputSchema as Row, field),
    });
    const projectedStructured = structuredOf(projected);
    if (projectedStructured === null) {
      report.projectionUnexercised.push(`${name} (declined when projected)`);
      continue;
    }
    report.projectionChecked += 1;
    report.violations.push(
      ...violationsFor(schema, projectedStructured, name, `projected:${field}`),
    );
  }
  return report;
}

export function formatReport(report: ConformanceReport): string {
  const lines = [
    `tools validated against their own published outputSchema: ${report.checked}`,
    `of those, also validated under their own \`fields\` projection: ${report.projectionChecked}`,
  ];
  if (report.projectionUnexercised.length > 0) {
    lines.push(
      `projection unexercised (served no rows): ${report.projectionUnexercised.join(", ")}`,
    );
  }
  if (report.declined.length > 0) {
    lines.push(
      `declined for their example arguments: ${report.declined.join(", ")}`,
    );
  }
  if (report.undocumented.length > 0) {
    lines.push(
      `not callable -- a required parameter declares no example: ${report.undocumented.join(", ")}`,
    );
  }
  if (report.violations.length === 0) {
    lines.push("");
    lines.push("No response violated the schema it publishes.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${report.violations.length} SCHEMA VIOLATION(S):`);
  for (const violation of report.violations) {
    lines.push(
      `  ${violation.tool} [${violation.call}] ${violation.path}: ${violation.message}`,
    );
  }
  return lines.join("\n");
}

// Guarded so the module can be imported by its test without sweeping
// production, matching scripts/check-response-conformance.ts.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")
) {
  const report = await run();
  console.log(formatReport(report));
  // A violation is a real contract defect -- the response does not match the
  // schema we publish, which needs no judgement to confirm. Unlike the triage
  // sweep's SUSPECT flags, it fails.
  if (report.violations.length > 0) process.exitCode = 1;
  // Zero validated tools means the sweep did not run, not that everything
  // passed. Without this the check reports "No response violated the schema it
  // publishes" after a total outage.
  if (report.checked === 0) {
    console.error(
      "No tool was validated at all -- treating as a failure rather than a clean run.",
    );
    process.exitCode = 1;
  }
}
