import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import { loadRuntimeVersionHistoryColdTier } from "../src/runtime-versions-cold-tier.ts";
import { loadIndexedRuntimeHistory } from "../src/indexed-runtime-history.ts";
import { buildRuntimeVersionHistory } from "../src/runtime-versions.ts";
vi.mock("../src/indexed-runtime-history.ts", () => ({
  loadIndexedRuntimeHistory: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
});
const env = { R2_SQL_TOKEN: "legacy-test" };
test("verified indexed timeline preserves rollback and nullable observations", async () => {
  const expected = buildRuntimeVersionHistory(
    [
      { spec_version: 1, block_number: 0, observed_at: null },
      { spec_version: 2, block_number: 10, observed_at: 1000 },
    ],
    { spec_version: 1, block_number: 20 },
  );
  vi.mocked(loadIndexedRuntimeHistory).mockResolvedValue(expected);
  assert.deepEqual(await loadRuntimeVersionHistoryColdTier(env), expected);
});
test("missing and failed indexed owners decline without SQL", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("No SQL"));
  for (const value of [undefined, null]) {
    vi.mocked(loadIndexedRuntimeHistory).mockResolvedValue(value);
    assert.equal(await loadRuntimeVersionHistoryColdTier(env), null);
  }
  assert.equal(fetch.mock.calls.length, 0);
});

describe("all three runtime surfaces go through the one reader", () => {
  // The regression is a surface wired to the lakehouse while its siblings are
  // not. A call site either exists or it does not, so reading the sources
  // asserts it exactly.
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadRuntimeVersionHistoryColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadRuntimeVersionHistoryColdTier\(/,
        `${surface} (${path}) would answer an empty timeline while its ` +
          "siblings answer the real one",
      );
    }
  });

  test("no surface still claims spec_version cannot be back-filled", () => {
    // That caveat described the retired D1 tier's never-back-filled nullable
    // ALTER. The lakehouse carries a reading on every block, so repeating it
    // would tell callers to distrust a complete timeline.
    for (const path of [...Object.values(sources), "src/contracts.ts"]) {
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        /spec_version (?:wasn't tracked|is best-effort)/,
        `${path} repeats the retired tier's coverage caveat`,
      );
    }
  });
});
