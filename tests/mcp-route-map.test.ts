// The declared route<->tool map (#9880).
//
// The gate itself (scripts/validate-mcp-route-map.ts) does the set comparisons
// against openapi.json. These tests pin the things a gate cannot: that the map
// is a DECLARATION rather than a heuristic, that `null` carries its reason, and
// that the description an agent reads agrees with the route we declare.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";
import type { Row } from "./row-type.ts";

const tools = listToolDefinitions() as Row[];
const published = new Set(
  Object.keys(
    (JSON.parse(readFileSync("public/metagraph/openapi.json", "utf8")) as Row)
      .paths as Row,
  ),
);

describe("MCP_TOOL_ROUTES (#9880)", () => {
  test("classifies every registered tool, with nothing left over", () => {
    assert.deepEqual(
      tools.map((t) => t.name as string).sort(),
      Object.keys(MCP_TOOL_ROUTES).sort(),
    );
  });

  test("a null route always carries a real reason", () => {
    // `null` is a classification, not an omission -- the same contract
    // TABLE_FRESHNESS's `maxAgeMs: null` has. A reason-less null would be
    // indistinguishable from "nobody looked".
    const nulls = Object.entries(MCP_TOOL_ROUTES).filter(
      ([, e]) => e.route === null,
    );
    assert.ok(nulls.length > 0, "no route-less tools -- the fixture is wrong");
    for (const [name, entry] of nulls) {
      assert.ok(
        (entry.reason ?? "").length > 20,
        `${name} declares route: null with no real reason`,
      );
    }
  });

  test("every declared route is published, and none is the network-prefixed form", () => {
    for (const [name, entry] of Object.entries(MCP_TOOL_ROUTES)) {
      for (const route of [
        ...(entry.route ? [entry.route] : []),
        ...(entry.additionalRoutes ?? []),
      ]) {
        assert.ok(published.has(route), `${name} -> ${route} is not published`);
        assert.ok(
          !route.startsWith("/api/v1/{network}/"),
          `${name} declares the network-addressed form ${route}`,
        );
      }
    }
  });

  test("a tool that names a route in its description declares that same route", () => {
    // The description is what an agent reads; the map is what tooling reads.
    // They drifting apart is the failure this catches -- two tools were
    // pointing at `{ref}` and `{block_number}` path parameters that do not
    // exist, found exactly this way.
    const mismatches: string[] = [];
    for (const tool of tools) {
      const entry = MCP_TOOL_ROUTES[tool.name as string];
      const named = [
        ...new Set(
          [
            ...String(tool.description).matchAll(
              /\b(?:GET|POST)\s+(\/api\/v1[^\s,.)`"';?]*)/g,
            ),
          ].map((m) => m[1]),
        ),
      ];
      if (named.length === 0) continue;
      // A tool the map declares route-LESS may still name routes in its prose:
      // `run_saved_query` cites /api/v1/registry/leaderboards and
      // /api/v1/chain/registrations as EXAMPLES of what a saved query reads.
      // Its `reason` is where that is explained, and the reason check above is
      // what keeps it honest -- so the drift check applies to tools that do
      // declare a route, which is where a wrong path parameter hides.
      if (entry?.route === null) continue;
      const declared = new Set([
        ...(entry?.route ? [entry.route] : []),
        ...(entry?.additionalRoutes ?? []),
      ]);
      for (const route of named) {
        if (!declared.has(route)) {
          mismatches.push(
            `${tool.name}: description names ${route}, map declares ${entry?.route ?? "null"}`,
          );
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test("the map is a declaration, not a name heuristic", () => {
    // The five tools whose names share no useful token with their path. If a
    // future refactor replaces the map with a derivation, these break first --
    // which is the whole argument recorded in the map's header.
    const IRREGULAR: Array<[string, string]> = [
      ["get_self_health", "/api/v1/self-health"],
      ["get_build", "/api/v1/build"],
      ["get_coverage", "/api/v1/coverage"],
      ["get_changelog", "/api/v1/changelog"],
      ["list_global_validators", "/api/v1/validators"],
    ];
    for (const [tool, route] of IRREGULAR) {
      assert.equal(
        MCP_TOOL_ROUTES[tool]?.route,
        route,
        `${tool} should mirror ${route}`,
      );
    }
  });

  test("the gate is registered so it actually runs", () => {
    // A validator that exists and runs nowhere is the defect #9879 was about.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Row;
    assert.ok((pkg.scripts as Row)["validate:mcp-route-map"]);
    const workflow = readFileSync(".github/workflows/validate.yml", "utf8");
    assert.match(workflow, /npm run validate:mcp-route-map/);
  });
});
