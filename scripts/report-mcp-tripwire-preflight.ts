// Would the MCP response tripwire reject anything production is serving today?
// (#10789)
//
// The tripwire parses every tool result against the schema that tool publishes,
// and it THROWS. Turning that on without measuring first is how an enforcement
// flag becomes an outage: the schemas moved a great deal in #10786 and #10790,
// and "the contract is right" was a claim about the contract, not about the
// producer.
//
// ## WHY THE SCHEDULED SWEEP DOES NOT ANSWER THIS
//
// `scripts/check-mcp-conformance.ts` reads `tools/list` from production and
// validates production's answers against **the schemas production publishes**.
// That is the right question for a scheduled check -- it catches a server whose
// answers stopped matching its own contract -- and the wrong one here, because
// a deployed contract agreeing with its deployed producer says nothing about
// the contract in this working tree. It reported 229 tools clean while the
// schemas about to ship were materially stricter.
//
// So this asks the other question: production's RESPONSES against the LOCAL
// schemas. It runs `validateMcpResponseTripwire` itself rather than a
// re-implementation, so the measurement and the enforcement cannot disagree
// about which schema describes a tool or what counts as a violation.
//
// ## WHAT A FINDING MEANS
//
// A shape production serves that the schema about to ship does not describe.
// Each is one of two things, and the difference decides the fix:
//
//   the SCHEMA is wrong    it tightened past what the producer can promise, and
//                          the fix is at the Zod. The common case after a
//                          strict migration.
//   the PRODUCER is wrong  it emits something undeclared, and the fix is to
//                          declare it or stop emitting it (#10790's triage).
//
// Never widen the schema to make the report quiet -- that is the leak guard
// that does not guard, reintroduced by hand.
import { pathToFileURL } from "node:url";
import {
  callTool,
  listLiveTools,
  structuredOf,
} from "./check-mcp-conformance.ts";
import {
  buildToolArguments,
  projectableFieldFrom,
  projectionArgumentFor,
} from "./mcp-tool-arguments.ts";
import {
  McpResponseSchemaDriftError,
  validateMcpResponseTripwire,
} from "../src/mcp-response-tripwire.ts";

type Row = Record<string, unknown>;

/** One tool's production result measured against the schema this tree ships. */
export interface PreflightFinding {
  tool: string;
  detail: unknown;
}

export interface PreflightReport {
  /** Production responses parsed against a LOCAL schema. */
  checked: number;
  /** Advertised by production, absent here -- nothing to compare against. */
  unknownLocally: string[];
  /** No local schema carries a Zod source, so the tripwire would skip it. */
  unresolved: string[];
  /** Declined for their example arguments, so there was no response. */
  declined: string[];
  /** Also parsed under their own `fields` projection. */
  projectionChecked: number;
  /** `fields`-capable but with no rows to project right now. */
  projectionUnexercised: string[];
  findings: PreflightFinding[];
}

/**
 * The output schemas this tree would SERVE, keyed by tool.
 *
 * Read through `listToolDefinitions()` rather than the `MCP_TOOLS` array:
 * `stripSentinelIntegerBounds` rewrites what is actually published, and
 * measuring the array instead of the served list is a mistake #10279 made once
 * already -- it reported 82 sentinel bounds that nothing ever serves.
 */
async function localToolSchemas(): Promise<Map<string, unknown>> {
  const { listToolDefinitions } = (await import("../src/mcp-server.ts")) as {
    listToolDefinitions: () => Promise<Row[]> | Row[];
  };
  const served = await listToolDefinitions();
  return new Map(
    served.flatMap((tool) =>
      tool.outputSchema ? [[String(tool.name), tool.outputSchema]] : [],
    ),
  );
}

/** Run the tripwire itself, recording a drift rather than throwing out. */
function parse(
  report: PreflightReport,
  label: string,
  published: unknown,
  structured: unknown,
): void {
  try {
    validateMcpResponseTripwire(label, published, structured);
  } catch (err) {
    if (err instanceof McpResponseSchemaDriftError) {
      report.findings.push({ tool: label, detail: err.detail });
      return;
    }
    throw err;
  }
}

export async function run(): Promise<PreflightReport> {
  const [live, local] = await Promise.all([
    listLiveTools(),
    localToolSchemas(),
  ]);
  const report: PreflightReport = {
    checked: 0,
    unknownLocally: [],
    unresolved: [],
    declined: [],
    projectionChecked: 0,
    projectionUnexercised: [],
    findings: [],
  };

  for (const tool of live) {
    const name = String(tool.name);
    const published = local.get(name);
    if (!published) {
      report.unknownLocally.push(name);
      continue;
    }
    const { args, undocumented } = buildToolArguments(tool.inputSchema as Row);
    if (undocumented.length > 0) continue;
    const structured = structuredOf(await callTool(name, args));
    if (structured === null) {
      // A decline is not a finding: production legitimately answers not_found
      // for an example subject that has since changed. Counted so the total is
      // legible rather than quietly smaller.
      report.declined.push(name);
      continue;
    }
    report.checked += 1;
    parse(report, name, published, structured);

    // THE PROJECTED PATH -- the one #9884 broke while CI stayed green. A tool
    // answering `{items: []}` satisfies any row schema vacuously, and deriving
    // MCP schemas from route schemas made 25 tools fail their own contract the
    // moment a caller used the `fields` parameter they advertise. Sweeping only
    // the plain path would measure the half that was never the problem.
    const properties = ((tool.inputSchema as Row)?.properties ?? {}) as Row;
    if (!properties.fields) continue;
    const field = projectableFieldFrom(structured);
    if (!field) {
      report.projectionUnexercised.push(name);
      continue;
    }
    const projected = structuredOf(
      await callTool(name, {
        ...args,
        fields: projectionArgumentFor(tool.inputSchema as Row, field),
      }),
    );
    if (projected === null) {
      report.projectionUnexercised.push(`${name} (declined when projected)`);
      continue;
    }
    report.projectionChecked += 1;
    parse(report, `${name} (projected:${field})`, published, projected);
  }
  return report;
}

function main(): void {
  run()
    .then((report) => {
      console.log(
        `mcp-tripwire-preflight: ${report.checked} production response(s) ` +
          `parsed against the schema this tree publishes ` +
          `(${report.projectionChecked} of them also under their own ` +
          `\`fields\` projection); ${report.findings.length} would be ` +
          `REJECTED.`,
      );
      for (const finding of report.findings) {
        console.log(
          `  ${finding.tool}: ${JSON.stringify(finding.detail).slice(0, 400)}`,
        );
      }
      if (report.declined.length) {
        console.log(
          `  ${report.declined.length} declined for their example arguments: ` +
            report.declined.join(", "),
        );
      }
      if (report.unknownLocally.length) {
        console.log(
          `  ${report.unknownLocally.length} advertised by production and ` +
            `absent here: ${report.unknownLocally.join(", ")}`,
        );
      }
      process.exitCode = report.findings.length ? 1 : 0;
    })
    .catch((err: unknown) => {
      console.error("mcp-tripwire-preflight failed:", err);
      process.exitCode = 1;
    });
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
