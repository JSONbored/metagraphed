// Every MCP-vs-REST constraint difference is DECLARED, or it is drift (#10060).
//
// `validate-mcp-input-parity.ts` checks one direction -- a tool must not accept
// what its route rejects. This checks the other half of the same question: for
// every argument a tool shares with the route it mirrors, either the published
// constraints match, or the difference belongs to a class this file names.
//
// The epic's headline number was 217 divergences. Re-measuring it correctly is
// most of what this script is for, because two of the ways it was wrong are
// permanent hazards for anyone who measures again:
//
//   READ THE SERVED LIST. `MCP_TOOLS` still carries `z.int()`'s
//   `maximum: 9007199254740991`; `listToolDefinitions()` strips it. Reading the
//   raw table reported 82 sentinel ceilings the surface does not publish.
//
//   A TOOL MAY MIRROR MORE THAN ONE ROUTE. `list_review_gaps` reads
//   /api/v1/gaps AND /api/v1/review/gaps, and comparing it against the primary
//   alone reports its correct match with the second as a divergence.
//
// What is left after both corrections is every difference being an ENCODING (a
// boolean filter is `enum:["true","false"]` on a query string and `boolean` in
// typed JSON) or a NARROWING (a tool sized to a context window, per #9701) or
// one of the DECLARED entries below. This gate is what keeps that true: a NEW
// difference in any other class fails.
//
// The count itself is deliberately not written down here -- it moves with every
// tool and route added, and a number in a comment is a claim nothing checks.
// Run the gate; it prints the current one.
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { readJson, repoRoot } from "./lib.ts";
import path from "node:path";

type Row = Record<string, unknown>;

/** The constraint keywords a caller is bound by. Prose and examples are per
 * surface by design (#10060), so they are not compared. */
const KEYS = [
  "type",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "default",
] as const;

/** JSON Schema types a query string can carry. Anything else on the tool side
 * is the typed-JSON encoding of the same parameter. */
const WIRE_TYPES = new Set(["string", "integer", "number"]);

const openapi = (await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
)) as { paths: Record<string, Record<string, { parameters?: Row[] }>> };

function routeParameters(routePath: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const parameter of (openapi.paths[routePath]?.get?.parameters ??
    []) as Row[]) {
    if (parameter.in === "query") {
      out.set(String(parameter.name), (parameter.schema ?? {}) as Row);
    }
  }
  return out;
}

/**
 * The difference between one route schema and one tool schema, classified.
 *
 * `null` means they agree. A returned string names the class, and only the
 * classes below are tolerated.
 */
function classify(route: Row, tool: Row): string | null {
  const differing = KEYS.filter(
    (key) => JSON.stringify(route[key]) !== JSON.stringify(tool[key]),
  );
  if (differing.length === 0) return null;

  const toolType = tool.type;
  // ENCODING. The route reads a query STRING and the tool is handed real JSON,
  // so one parameter is honestly two shapes: a boolean filter, a repeatable
  // parameter that becomes an array, a union of "one or many".
  if (
    (toolType !== undefined && !WIRE_TYPES.has(String(toolType))) ||
    tool.anyOf !== undefined ||
    tool.oneOf !== undefined
  ) {
    return null;
  }
  // A NARROWING: the tool admits strictly less than its route, for a context
  // window rather than for correctness (#9701). Only ever tighter -- a LOOSER
  // tool is what validate-mcp-input-parity refuses, and a WIDER one is #10109.
  const subset = (a: unknown, b: unknown) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.every((value) => (b as unknown[]).includes(value));
  const narrowingOnly = differing.every(
    (key) =>
      (key === "default" && tool.default !== undefined) ||
      (key === "maximum" &&
        typeof tool.maximum === "number" &&
        (typeof route.maximum !== "number" || tool.maximum <= route.maximum)) ||
      (key === "minimum" &&
        typeof tool.minimum === "number" &&
        (typeof route.minimum !== "number" || tool.minimum >= route.minimum)) ||
      (key === "maxLength" &&
        typeof tool.maxLength === "number" &&
        (typeof route.maxLength !== "number" ||
          tool.maxLength <= route.maxLength)) ||
      // A pattern the route does not publish can only reject more.
      (key === "pattern" && route.pattern === undefined) ||
      (key === "enum" && subset(tool.enum, route.enum)),
  );
  if (narrowingOnly) return null;

  return differing
    .map(
      (key) =>
        `${key}: route ${JSON.stringify(route[key])} vs tool ${JSON.stringify(tool[key])}`,
    )
    .join("; ");
}

/**
 * Differences that are neither an encoding nor a narrowing, and are DELIBERATE.
 *
 * Same contract as every other DECLARED list in this repo: an entry is a
 * standing admission with a reason, the list may only shrink, and a stale entry
 * fails below rather than sitting there.
 */
const DECLARED: Record<string, string> = {
  // #10109 examined exactly this pair and left it: workers/api.ts clamps
  // /api/v1/chain-events at CHAIN_EVENTS_LIMIT_MAX (100) and the reader behind
  // the MCP tools clamps at MCP_CHAIN_EVENTS_LIMIT_MAX (200). Two surfaces,
  // two ceilings, both enforced. What was wrong was openapi.json publishing
  // the MCP number for the REST route; the surface difference itself is a
  // product decision with a written rationale (src/data-api-mcp.ts).
  "list_chain_events.limit": "MCP reader clamps at 200, REST at 100 (#10109)",
  "get_extrinsic_chain_events.limit":
    "MCP reader clamps at 200, REST at 100 (#10109)",
};

const errors: string[] = [];
const usedDeclarations = new Set<string>();
let pairs = 0;
let agree = 0;

for (const tool of listToolDefinitions() as unknown as {
  name: string;
  inputSchema?: Row;
}[]) {
  const entry = (
    MCP_TOOL_ROUTES as Record<
      string,
      { route: string | null; additionalRoutes?: string[] }
    >
  )[tool.name];
  if (!entry?.route) continue;
  const mirrored = [entry.route, ...(entry.additionalRoutes ?? [])];
  const candidates = new Map<string, Row[]>();
  for (const routePath of mirrored) {
    for (const [name, schema] of routeParameters(routePath)) {
      const list = candidates.get(name) ?? [];
      list.push(schema);
      candidates.set(name, list);
    }
  }
  const properties = (tool.inputSchema?.properties ?? {}) as Record<
    string,
    Row
  >;
  for (const [name, toolSchema] of Object.entries(properties)) {
    const forName = candidates.get(name);
    if (!forName) continue;
    pairs += 1;
    // Agreement with ANY mirrored route is agreement.
    const verdicts = forName.map((route) => classify(route, toolSchema));
    if (verdicts.some((verdict) => verdict === null)) {
      agree += 1;
      continue;
    }
    const key = `${tool.name}.${name}`;
    if (DECLARED[key]) {
      usedDeclarations.add(key);
      continue;
    }
    errors.push(`${key} — ${verdicts[0]}`);
  }
}

const stale = Object.keys(DECLARED).filter((key) => !usedDeclarations.has(key));
if (stale.length > 0) {
  errors.push(
    `${stale.length} DECLARED entr(y/ies) no longer describe a difference — delete them: ${stale.join(", ")}`,
  );
}

if (errors.length > 0) {
  console.error(
    `Tool/route divergence validation failed with ${errors.length} undeclared difference(s):\n` +
      errors.map((line) => `- ${line}`).join("\n") +
      "\n  A tool and the route it mirrors must publish the same constraints, " +
      "unless the difference is the wire-vs-JSON encoding or a declared " +
      "narrowing (tighter bound, tighter default). Anything else is drift.",
  );
  process.exit(1);
}

console.log(
  `Tool/route divergence validation passed: ${pairs} shared argument(s), ` +
    `${agree} reconciled, ${Object.keys(DECLARED).length} declared difference(s), ` +
    "0 undeclared.",
);
