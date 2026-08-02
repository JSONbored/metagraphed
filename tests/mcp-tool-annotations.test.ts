// #8964: tool annotations are a safety surface, not documentation. Agent
// harnesses read `readOnlyHint` to decide what may be invoked without asking a
// human — so a tool that forwards caller-supplied writes to a third-party host
// while advertising itself read-only can induce an otherwise careful agent to
// make credentialed writes it would never have made knowingly.
//
// These tests pin the three claims that matter:
//   1. `call_subnet_surface` — the only true mutator — is never read-only.
//   2. Every tool that leaves metagraphed infrastructure declares open-world,
//      and every tool that does not, does not.
//   3. The open-world list cannot silently rot: a tool whose handler reaches a
//      known outbound helper must appear in it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  MCP_TOOLS,
  OPEN_WORLD_TOOL_NAMES,
  listToolDefinitions,
  parseUserAgentClient,
} from "../src/mcp-server.ts";

const definitions = listToolDefinitions();
const byName = new Map(definitions.map((def) => [def.name, def]));

describe("MCP tool annotations", () => {
  test("every tool advertises a complete annotation block", () => {
    for (const def of definitions) {
      const annotations = def.annotations as Record<string, unknown>;
      assert.ok(annotations, `${def.name} has no annotations`);
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        assert.equal(
          typeof annotations[hint],
          "boolean",
          `${def.name}.${hint} must be a boolean`,
        );
      }
    }
  });

  // The specific defect #8964 was filed for. call_subnet_surface issues
  // caller-supplied POST/PUT with a caller-supplied credential to third-party
  // subnet hosts; every one of these four claims was previously wrong.
  test("call_subnet_surface is not advertised as a safe read", () => {
    const annotations = byName.get("call_subnet_surface")
      ?.annotations as Record<string, unknown>;
    assert.ok(annotations, "call_subnet_surface must be registered");
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    // A caller-supplied POST/PUT is not idempotent by construction.
    assert.equal(annotations.idempotentHint, false);
    assert.equal(annotations.openWorldHint, true);
  });

  test("openWorldHint is true exactly for the tools that leave our infrastructure", () => {
    const declaredOpenWorld = definitions
      .filter(
        (def) =>
          (def.annotations as Record<string, unknown>)?.openWorldHint === true,
      )
      .map((def) => def.name)
      .sort();
    assert.deepEqual(declaredOpenWorld, [...OPEN_WORLD_TOOL_NAMES].sort());
  });

  // Pins the #8964 audit's finding: 20 of 207 tools leave our infrastructure.
  // Not a style rule — an accidental widening of the open-world set is how the
  // signal gets diluted back to useless, which is the state this issue fixed.
  test("the open-world set stays small relative to the catalogue", () => {
    assert.equal(OPEN_WORLD_TOOL_NAMES.length, 20);
    assert.ok(
      definitions.length > 200,
      `expected the full catalogue, saw ${definitions.length}`,
    );
  });

  test("the open-world list has no stale entries", () => {
    for (const name of OPEN_WORLD_TOOL_NAMES) {
      assert.ok(
        byName.has(name),
        `${name} is annotated but no longer registered`,
      );
    }
  });

  // Only call_subnet_surface may claim non-read-only. If another mutating tool
  // lands, this test failing is the intended prompt to give it a truthful
  // block rather than to widen the list reflexively.
  test("call_subnet_surface is the only non-read-only tool", () => {
    const mutating = definitions
      .filter(
        (def) =>
          (def.annotations as Record<string, unknown>)?.readOnlyHint !== true,
      )
      .map((def) => def.name);
    assert.deepEqual(mutating, ["call_subnet_surface"]);
  });
});

// The regression guard the annotation table needs to stay honest: scan each
// tool's own handler body for a call into a helper we know performs outbound
// I/O, and require it to be annotated open-world. This catches the common
// shape — a new `get_*` tool that calls one of the live-RPC loaders and
// inherits the closed-world default — without trying to prove reachability
// through the whole import graph (a tool reaching outbound I/O three modules
// deep still needs a human to notice; see the note in the issue).
describe("open-world annotation guard", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/mcp-server.ts", import.meta.url)),
    "utf8",
  );

  // Helpers whose implementations perform outbound I/O to hosts we do not
  // operate (public Bittensor RPC, Workers AI/Vectorize, third-party surface
  // hosts, third-party RPC pools).
  const OUTBOUND_HELPERS = [
    "loadAccountBalance",
    "loadAccountRootClaim",
    "loadAccountChildren",
    "loadAccountParents",
    "loadNetworkParameters",
    "loadRandomnessStatus",
    "loadSubnetBurn",
    "loadSubnetLease",
    "loadSubnetRecycled",
    "loadSudoKey",
    "loadAddressMapping",
    "loadUpgradeRadar",
    "callSubnetSurface",
    "verifySurfaceWithCache",
    "handleRpcProxyRequest",
    "askQuestion",
    "semanticSearch",
  ];

  test("no tool reaches an outbound helper while claiming closed-world", () => {
    const openWorld = new Set(OPEN_WORLD_TOOL_NAMES);
    const offenders: string[] = [];

    for (const tool of MCP_TOOLS) {
      if (openWorld.has(tool.name)) continue;
      // Slice the source from this tool's registration to the next one, which
      // brackets its handler body. Tools contributed by object-spread have no
      // inline `name:` line and are skipped — every one of them is an
      // artifact/Postgres reader (verified in the #8964 audit).
      const start = source.indexOf(`    name: "${tool.name}",`);
      if (start === -1) continue;
      const next = source.indexOf('\n    name: "', start + 1);
      const body = source.slice(start, next === -1 ? source.length : next);
      const reached = OUTBOUND_HELPERS.filter((helper) =>
        new RegExp(`\\b${helper}\\s*\\(`).test(body),
      );
      if (reached.length > 0) {
        offenders.push(`${tool.name} -> ${reached.join(", ")}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these tools perform outbound I/O but are annotated closed-world; ` +
        `add them to TOOL_ANNOTATIONS_BY_NAME in src/mcp-server.ts:\n` +
        offenders.join("\n"),
    );
  });
});

// #8963: the only client signal a tools/call request carries when it has no
// Mcp-Session-Id — which is ~80% of production traffic.
describe("parseUserAgentClient", () => {
  test("splits the conventional name/version first token", () => {
    assert.deepEqual(parseUserAgentClient("claude-code/2.1.220"), {
      clientName: "claude-code",
      clientVersion: "2.1.220",
    });
    assert.deepEqual(parseUserAgentClient("python-httpx/0.27.0 extra/bits"), {
      clientName: "python-httpx",
      clientVersion: "0.27.0",
    });
  });

  test("keeps a versionless agent as a bare name", () => {
    assert.deepEqual(parseUserAgentClient("node"), { clientName: "node" });
    assert.deepEqual(parseUserAgentClient("  curl  "), { clientName: "curl" });
  });

  test("handles a path-shaped agent without inventing an empty name", () => {
    assert.deepEqual(parseUserAgentClient("/1.0"), { clientName: "/1.0" });
  });

  test("returns nothing for an absent or unusable header", () => {
    assert.deepEqual(parseUserAgentClient(null), {});
    assert.deepEqual(parseUserAgentClient(undefined), {});
    assert.deepEqual(parseUserAgentClient(""), {});
    assert.deepEqual(parseUserAgentClient("   "), {});
    assert.deepEqual(parseUserAgentClient(42), {});
  });

  test("caps a hostile agent so it cannot dominate a telemetry payload", () => {
    const parsed = parseUserAgentClient(
      `${"a".repeat(500)}/${"b".repeat(500)}`,
    );
    assert.equal(parsed.clientName?.length, 80);
    assert.equal(parsed.clientVersion?.length, 80);
  });
});
