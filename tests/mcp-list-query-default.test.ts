// Every MCP list loader pages through the seam that carries a default (#9730).
//
// The defect this guards is not "a tool returns too much once". It is that the
// hole is INVISIBLE at the call site: `applyQueryFilters` with no `limit` and no
// `cursor` returns every row, silently, and nothing about writing a new loader
// suggests otherwise. #9701 fixed one instance by hand; sixteen more were still
// live when #9730 measured them, the largest at 9,059,868 bytes.
//
// So the gate is structural rather than per-tool: no module under src/*-mcp.ts
// may reach past src/mcp-list-query.ts to the raw engine. A loader added
// tonight is covered tonight, without anyone remembering to add it to a list.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { applyMcpQueryFilters } from "../src/mcp-list-query.ts";
import { applyQueryFilters } from "../workers/list-query.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../src/route-limits.ts";
import type { Row } from "./row-type.ts";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/**
 * The modules allowed to import the raw engine.
 *
 * `mcp-list-query.ts` IS the wrapper. `graphql.ts` is a third surface with its
 * own pagination contract -- a GraphQL query states its own page size and an
 * invalid one is an error rather than a substituted default, so a hidden
 * default there would contradict the schema clients read.
 */
const MAY_IMPORT_THE_RAW_ENGINE = new Set(["mcp-list-query.ts", "graphql.ts"]);

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts"));
}

describe("MCP list pagination default (#9730)", () => {
  test("no MCP loader reaches past the wrapper to the raw engine", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const name of sourceFiles()) {
      const source = readFileSync(path.join(SRC_DIR, name), "utf8");
      if (!source.includes("list-query.ts")) continue;
      checked += 1;
      if (MAY_IMPORT_THE_RAW_ENGINE.has(name)) continue;
      // The import specifier, not the call: a module could alias the symbol,
      // and what must not happen is reaching the raw module at all.
      if (/from "\.\.\/workers\/list-query\.ts"/.test(source)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these import the raw engine directly and so page unbounded — import ` +
        `applyMcpQueryFilters from ./mcp-list-query.ts instead: ${offenders.join(", ")}`,
    );
    // A pass over nothing proves nothing. If the layout changes such that no
    // module matches, this fails rather than going quietly green.
    assert.ok(
      checked > 25,
      `expected well over 25 modules touching the list engine, saw ${checked}`,
    );
  });

  test("the wrapper defaults a page the raw engine would have left unbounded", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      netuid: index,
      name: `sn-${index}`,
      slug: `sn-${index}`,
      coverage_level: "probed",
      curation_level: "maintainer-reviewed",
      gaps: { missing_kinds: [], supported_kinds: [], gap_notes: [] },
    }));
    const url = () => new URL("https://mcp.internal/gaps");

    // The behaviour that shipped: every row, from a call that asked for none.
    const raw = applyQueryFilters({ gaps: rows }, url(), "gaps", []) as {
      data: Row;
    };
    assert.equal(
      (raw.data.gaps as Row[]).length,
      200,
      "the raw engine is expected to stay unbounded — REST depends on it",
    );

    const wrapped = applyMcpQueryFilters({ gaps: rows }, url(), "gaps", []) as {
      data: Row;
      meta: Row;
    };
    assert.equal((wrapped.data.gaps as Row[]).length, MCP_LIST_LIMIT_DEFAULT);
    // Reachable by paging, which is the difference between a default and a cap.
    const pagination = wrapped.meta.pagination as Row;
    assert.equal(pagination.total, 200);
    assert.equal(pagination.returned, MCP_LIST_LIMIT_DEFAULT);
    assert.equal(pagination.next_cursor, MCP_LIST_LIMIT_DEFAULT);
  });

  test("an explicit limit still wins, in both directions", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      netuid: index,
      name: `sn-${index}`,
      slug: `sn-${index}`,
      coverage_level: "probed",
      curation_level: "maintainer-reviewed",
      gaps: { missing_kinds: [], supported_kinds: [], gap_notes: [] },
    }));
    const withLimit = (value: string) => {
      const url = new URL("https://mcp.internal/gaps");
      url.searchParams.set("limit", value);
      return applyMcpQueryFilters({ gaps: rows }, url, "gaps", []) as {
        data: Row;
      };
    };
    // Smaller than the default.
    assert.equal((withLimit("5").data.gaps as Row[]).length, 5);
    // And larger — the default must not have become a ceiling.
    assert.equal((withLimit("100").data.gaps as Row[]).length, 100);
  });

  test("a cursor alone still pages, as it did before", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      netuid: index,
      name: `sn-${index}`,
      slug: `sn-${index}`,
      coverage_level: "probed",
      curation_level: "maintainer-reviewed",
      gaps: { missing_kinds: [], supported_kinds: [], gap_notes: [] },
    }));
    const url = new URL("https://mcp.internal/gaps");
    url.searchParams.set("cursor", "10");
    const { data } = applyMcpQueryFilters({ gaps: rows }, url, "gaps", []) as {
      data: Row;
    };
    const page = data.gaps as Row[];
    assert.equal(page.length, MCP_LIST_LIMIT_DEFAULT);
    assert.equal(page[0].netuid, 10, "the cursor must still offset the page");
  });

  test("a loader may raise its own ceiling, but has to say so", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      netuid: index,
      name: `sn-${index}`,
      slug: `sn-${index}`,
      coverage_level: "probed",
      curation_level: "maintainer-reviewed",
      gaps: { missing_kinds: [], supported_kinds: [], gap_notes: [] },
    }));
    const { data } = applyMcpQueryFilters(
      { gaps: rows },
      new URL("https://mcp.internal/gaps"),
      "gaps",
      [],
      { defaultLimit: 75 },
    ) as { data: Row };
    assert.equal((data.gaps as Row[]).length, 75);
  });
});
