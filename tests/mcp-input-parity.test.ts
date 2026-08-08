// The input-parity gate's own invariants (#10016).
//
// `validate:mcp-input-parity` compares every tool's ARGUMENTS to its route's
// published query parameters. It runs in CI and in `npm run check`; this pins
// the properties that make it worth running, so a rewrite of the script cannot
// quietly turn it into a no-op.
//
// The script's own behaviour (fail on an undeclared argument, fail on a stale
// declaration) was verified by injecting each and watching it reject.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";

type Row = Record<string, unknown>;

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as Row;

const publishedQuery = new Map<string, Set<string>>();
for (const [route, operations] of Object.entries(
  (openapi.paths ?? {}) as Record<string, Row>,
)) {
  const names = new Set<string>();
  for (const operation of Object.values(operations)) {
    for (const parameter of ((operation as Row)?.parameters ?? []) as Row[]) {
      if (parameter.in === "query") names.add(String(parameter.name));
    }
  }
  publishedQuery.set(route, names);
}

describe("MCP input parity", () => {
  test("every tool with a route resolves to a published route", () => {
    // The comparison is only meaningful over tools it can actually reach. If
    // this drops toward zero the gate passes while checking nothing, which is
    // how a gate becomes decoration.
    const withRoute = Object.entries(MCP_TOOL_ROUTES).filter(
      ([, entry]) => entry.route,
    );
    const resolvable = withRoute.filter(([, entry]) =>
      publishedQuery.has(entry.route as string),
    );
    assert.ok(
      resolvable.length > 200,
      `expected the comparison to reach most tools, reached ${resolvable.length}`,
    );
  });

  test("the declared list is a source file, not generated", () => {
    // A generated allowlist would grow itself back every time it was
    // regenerated, which defeats "the list may only shrink".
    const source = readFileSync("scripts/validate-mcp-input-parity.ts", "utf8");
    assert.match(source, /const DECLARED: Record<string, string> = \{\};/);
    assert.match(source, /NOT YET EXPOSED/);
    // Every category constant must carry prose. A bare marker like `true`
    // would let an entry be added without saying why.
    for (const marker of [
      "PATH_PARAMETER",
      "REQUEST_BODY",
      "MCP_NATIVE",
      "CURATED_VIEW",
      "RENAMED_ON_THE_MCP_SIDE",
      "NOT_YET_EXPOSED",
    ]) {
      assert.match(
        source,
        new RegExp(`const ${marker} =\\s*\\n?\\s*"`),
        `${marker} must be a written reason, not a flag`,
      );
    }
  });

  test("no tool silently accepts an argument named like a route parameter it lacks", () => {
    // The rename class (#10018), asserted structurally rather than by name:
    // if a tool takes `min_x` and its route publishes `min_y` where neither
    // side has the other, the two disagree at the boundary. Known cases are
    // declared; this catches a NEW one appearing between gate runs.
    const suspicious: string[] = [];
    for (const tool of listToolDefinitions()) {
      const route = MCP_TOOL_ROUTES[tool.name]?.route;
      const published = route ? publishedQuery.get(route) : undefined;
      if (!published) continue;
      const args = Object.keys(
        ((tool.inputSchema as Row)?.properties ?? {}) as Row,
      );
      for (const argument of args) {
        if (!argument.startsWith("min_") && !argument.startsWith("max_")) {
          continue;
        }
        if (published.has(argument)) continue;
        const opposite = [...published].find(
          (name) =>
            name.startsWith(argument.slice(0, 4)) && !args.includes(name),
        );
        if (opposite)
          suspicious.push(`${tool.name}: ${argument} vs ${opposite}`);
      }
    }
    // list_subnets' min_readiness/min_integration_readiness is the known pair
    // (#10018). Anything else is new and should be looked at.
    assert.deepEqual(
      suspicious.filter((entry) => !entry.startsWith("list_subnets:")),
      [],
    );
  });
});
