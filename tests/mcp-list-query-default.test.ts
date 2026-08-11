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

/**
 * Symbols in the raw engine that CANNOT page, and so are not what this gate is
 * about (#10793).
 *
 * The rule was written as "do not import the module", which is a proxy for the
 * real one: do not reach a function that returns every row when nobody asked.
 * `searchMatchingRows` is `?q=`'s matcher with the URLSearchParams lifted off
 * -- it filters and returns a subset, and cannot produce a page of any size.
 * Two MCP tools filter their rows by hand (`list_subnets`,
 * `list_enrichment_targets`) and need it so that `q` means the same thing on
 * both surfaces; the alternative was a second copy of the matcher, which is how
 * the two surfaces start disagreeing about what a search is.
 *
 * An ALLOWLIST of names rather than a relaxed module check, so the gate still
 * fails on the next symbol somebody reaches for. Adding one here is a claim
 * that it cannot page, and it has to be true.
 */
const NON_PAGING_ENGINE_EXPORTS = new Set(["searchMatchingRows"]);

/** The symbols a `from "../workers/list-query.ts"` import brings in. */
function importedEngineSymbols(source: string): string[] {
  const names: string[] = [];
  const importRe =
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\.\/workers\/list-query\.ts"/g;
  for (const match of source.matchAll(importRe)) {
    for (const clause of match[1].split(",")) {
      const name = clause
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * The rule itself, over one module's source: which PAGING symbols it reaches.
 *
 * Extracted from the sweep so it can be run against sources written to break
 * it -- a gate nobody has seen fail is a gate nobody knows still works.
 */
export function pagingEngineImports(source: string): string[] {
  if (!/from "\.\.\/workers\/list-query\.ts"/.test(source)) return [];
  const symbols = importedEngineSymbols(source);
  // A bare/namespace/`export *` form parses to no named symbols and is refused
  // outright -- it reaches everything, including what pages.
  return symbols.length === 0
    ? ["<non-named import>"]
    : symbols.filter((symbol) => !NON_PAGING_ENGINE_EXPORTS.has(symbol));
}

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
      // and what must not happen is reaching a PAGING function at all.
      const paging = pagingEngineImports(source);
      if (paging.length > 0) offenders.push(`${name} (${paging.join(", ")})`);
    }
    assert.deepEqual(
      offenders,
      [],
      `these import a paging function from the raw engine and so page ` +
        `unbounded — import applyMcpQueryFilters from ./mcp-list-query.ts ` +
        `instead: ${offenders.join(", ")}`,
    );
    // A pass over nothing proves nothing. If the layout changes such that no
    // module matches, this fails rather than going quietly green.
    assert.ok(
      checked > 25,
      `expected well over 25 modules touching the list engine, saw ${checked}`,
    );
  });

  // The rule was narrowed from "imports the module" to "imports something that
  // PAGES" when #10793 needed the `?q=` matcher in two hand-filtered tools.
  // Narrowing a gate is where gates quietly stop working, so these run it
  // against sources written to break it.
  describe("the narrowed rule still catches what it was written for", () => {
    test("a paging import is an offender, however it is written", () => {
      for (const source of [
        `import { applyQueryFilters } from "../workers/list-query.ts";`,
        // Aliased -- the reason the check reads the specifier, not the call.
        `import { applyQueryFilters as page } from "../workers/list-query.ts";`,
        // Smuggled in beside an allowed one.
        `import { searchMatchingRows, paginateRows } from "../workers/list-query.ts";`,
        // Multi-line, which is how a real import of two symbols is formatted.
        `import {\n  searchMatchingRows,\n  applyQueryFilters,\n} from "../workers/list-query.ts";`,
        // Type-only still reaches the module's shape; refuse it too rather
        // than reason about erasure.
        `import type { Row } from "../workers/list-query.ts";`,
        // Namespace and side-effect forms name nothing, so they reach
        // everything.
        `import * as engine from "../workers/list-query.ts";`,
      ]) {
        assert.notDeepEqual(
          pagingEngineImports(source),
          [],
          `should have been refused: ${source.replace(/\n/g, " ")}`,
        );
      }
    });

    test("the declared non-paging symbol is allowed, alone", () => {
      assert.deepEqual(
        pagingEngineImports(
          `import { searchMatchingRows } from "../workers/list-query.ts";`,
        ),
        [],
      );
    });

    test("a module that does not touch the engine is not an offender", () => {
      assert.deepEqual(
        pagingEngineImports(
          `import { applyMcpQueryFilters } from "./mcp-list-query.ts";`,
        ),
        [],
      );
    });
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
