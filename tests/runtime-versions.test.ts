import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  MAX_PLAUSIBLE_TRANSITION_BLOCK_SPAN,
  buildRuntimeVersionHistory,
  detectRuntimeCoverageGaps,
  formatRuntimeTransition,
  loadRuntimeVersionHistory,
} from "../src/runtime-versions.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

function transitionRow(overrides: Row = {}) {
  return {
    spec_version: 218,
    block_number: 5_123_456,
    observed_at: 1_750_000_000_000,
    ...overrides,
  };
}

describe("formatRuntimeTransition", () => {
  test("formats a full row", () => {
    const out = formatRuntimeTransition(transitionRow());
    assert.equal(out!.spec_version, 218);
    assert.equal(out!.block_number, 5_123_456);
    assert.equal(out!.observed_at, new Date(1_750_000_000_000).toISOString());
  });

  test("observed_at is null for a missing/non-finite/non-positive value", () => {
    for (const observed_at of [null, undefined, "garbage", NaN, 0, -5]) {
      const out = formatRuntimeTransition(transitionRow({ observed_at }));
      assert.equal(out!.observed_at, null, JSON.stringify(observed_at));
    }
  });

  test("observed_at is null for a finite ms value outside the Date-representable range", () => {
    const out = formatRuntimeTransition(transitionRow({ observed_at: 8.7e15 }));
    assert.equal(out!.observed_at, null);
  });

  test("tolerates D1 numeric-string cells for spec_version/block_number", () => {
    const out = formatRuntimeTransition(
      transitionRow({ spec_version: "218", block_number: "5123456" }),
    );
    assert.equal(out!.spec_version, 218);
    assert.equal(out!.block_number, 5_123_456);
  });

  test("returns null when spec_version can't be coerced", () => {
    for (const spec_version of [null, undefined, "", "   ", -1, 1.5, "abc"]) {
      assert.equal(
        formatRuntimeTransition(transitionRow({ spec_version })),
        null,
        JSON.stringify(spec_version),
      );
    }
  });

  test("returns null when block_number can't be coerced", () => {
    for (const block_number of [null, undefined, "", -1, 1.5, "abc"]) {
      assert.equal(
        formatRuntimeTransition(transitionRow({ block_number })),
        null,
        JSON.stringify(block_number),
      );
    }
  });

  test("returns null for a non-object row", () => {
    for (const row of [null, undefined, "nope", 5]) {
      assert.equal(
        formatRuntimeTransition(row as unknown as Row),
        null,
        JSON.stringify(row),
      );
    }
  });
});

describe("buildRuntimeVersionHistory", () => {
  test("shapes an ascending rows array into the transitions envelope", () => {
    const rows = [
      transitionRow({ spec_version: 217, block_number: 5_000_000 }),
      transitionRow({ spec_version: 218, block_number: 5_123_456 }),
      transitionRow({ spec_version: 219, block_number: 5_400_000 }),
    ];
    const out = buildRuntimeVersionHistory(rows, { spec_version: 219 }) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.transitions.length, 3);
    assert.equal(out.transition_count, 3);
    assert.equal(out.current_spec_version, 219);
    assert.equal(out.coverage_from_block, 5_000_000);
    assert.equal(
      out.coverage_from_at,
      new Date(1_750_000_000_000).toISOString(),
    );
  });

  test("current_spec_version comes from latestRow, not the last transitions entry — a spec_version reappearing after a newer one (a runtime rollback) does not report the superseded version as current", () => {
    // GROUP BY collapses 218's two occurrences (block 100 and the rollback at
    // block 300) into one row keyed by its EARLIEST block (100) — so the
    // transitions array only ever shows [218@100, 219@200], with no trace of
    // the block-300 reversion. latestRow (queried separately, by true
    // block_number DESC) is the only way to surface it.
    const rows = [
      transitionRow({ spec_version: 218, block_number: 100 }),
      transitionRow({ spec_version: 219, block_number: 200 }),
    ];
    const out = buildRuntimeVersionHistory(rows, { spec_version: 218 }) as Row;
    assert.equal(out.transitions[out.transitions.length - 1].spec_version, 219);
    assert.equal(out.current_spec_version, 218);
  });

  test("is cold-safe: empty/null rows and a null/missing latestRow yield the schema-stable empty shape", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildRuntimeVersionHistory(rows) as Row;
      assert.equal(out.transition_count, 0);
      assert.deepEqual(out.transitions, []);
      assert.equal(out.current_spec_version, null);
      assert.equal(out.coverage_from_block, null);
      assert.equal(out.coverage_from_at, null);
    }
  });

  test("drops unformattable rows without throwing", () => {
    const out = buildRuntimeVersionHistory([
      transitionRow({ spec_version: null }),
      transitionRow({ spec_version: 218, block_number: 5_123_456 }),
    ]) as Row;
    assert.equal(out.transition_count, 1);
    assert.equal(out.transitions[0].spec_version, 218);
  });
});

describe("loadRuntimeVersionHistory", () => {
  test("runs the boundary-aggregate + latest-reading queries and shapes the result", async () => {
    const calls: Row[] = [];
    const d1 = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("GROUP BY")) return [transitionRow()];
      return [{ spec_version: 218 }];
    };
    const out = (await loadRuntimeVersionHistory(d1)) as Row;
    assert.match(calls[0].sql, /GROUP BY spec_version/);
    assert.match(calls[0].sql, /WHERE spec_version IS NOT NULL/);
    assert.deepEqual(calls[0].params, []);
    assert.match(calls[1].sql, /ORDER BY block_number DESC LIMIT 1/);
    assert.deepEqual(calls[1].params, []);
    assert.equal(out.transition_count, 1);
    assert.equal(out.current_spec_version, 218);
  });

  test("cold D1 (empty rows) yields the schema-stable empty shape", async () => {
    const out = (await loadRuntimeVersionHistory(async () => [])) as Row;
    assert.equal(out.transition_count, 0);
    assert.equal(out.current_spec_version, null);
  });
});

const ctx = { waitUntil: (p: Promise<unknown>) => p };

// Stub METAGRAPH_HEALTH_DB that dispatches on the SQL text — the handler
// issues two distinct queries (the GROUP BY transitions aggregate and the
// ORDER BY block_number DESC LIMIT 1 latest-reading read), each needing its
// own canned rows. Mirrors hyperparamsEnv in tests/subnet-hyperparams.test.ts,
// extended for a two-query handler.
function runtimeEnv(
  transitionRows: Row[],
  latestRows: Row[] = transitionRows,
  captured: Row = {},
) {
  const calls: Row[] = [];
  captured.calls = calls;
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_CONTROL: {
      async get(key: string, options?: { type?: string }) {
        if (key !== "health:meta" || options?.type !== "json") return null;
        return { last_run_at: "2026-07-09T00:00:00.000Z" };
      },
    },
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            const rows = sql.includes("GROUP BY") ? transitionRows : latestRows;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

describe("GET /api/v1/runtime via the Worker", () => {
  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/runtime"),
      runtimeEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.transition_count, 0);
    assert.deepEqual(body.data.transitions, []);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/runtime?foo=bar"),
      runtimeEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("testnet has no variant (mainnet-only blocks D1 tier)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/runtime"),
      runtimeEnv([]) as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });
});

describe("detectRuntimeCoverageGaps", () => {
  const t = (spec_version: number, block_number: number) => ({
    spec_version,
    block_number,
    observed_at: null,
  });

  test("no gaps for a dense timeline", () => {
    const gaps = detectRuntimeCoverageGaps([
      t(437, 8_679_056),
      t(438, 8_686_925),
      t(439, 8_713_025),
      t(440, 8_713_793),
    ]);
    assert.deepEqual(gaps, []);
  });

  test("a spec_version skip is NOT a gap when blocks are close", () => {
    // Mainnet really did go 424 -> 432 -> 437: those releases never reached
    // mainnet, so the version sequence has holes with no data missing.
    const gaps = detectRuntimeCoverageGaps([
      t(424, 8_599_188),
      t(432, 8_636_190),
      t(437, 8_679_056),
    ]);
    assert.deepEqual(gaps, []);
  });

  test("flags the live 4M-block hole between spec 217 and 424", () => {
    const gaps = detectRuntimeCoverageGaps([
      t(217, 4_600_000),
      t(424, 8_599_188),
      t(432, 8_636_190),
    ]);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0], {
      after_spec_version: 217,
      before_spec_version: 424,
      after_block: 4_600_000,
      before_block: 8_599_188,
      block_span: 3_999_188,
    });
  });

  test("reports every interior hole, not just the first", () => {
    // Dense pair at the head, then two wide holes: only the wide ones count.
    const gaps = detectRuntimeCoverageGaps([
      t(101, 0),
      t(102, 561),
      t(217, 4_600_000),
      t(424, 8_599_188),
    ]);
    assert.equal(gaps.length, 2);
    assert.deepEqual(
      gaps.map((g) => g.after_spec_version),
      [102, 217],
    );
  });

  test("a span exactly at the threshold is not a gap; one block over is", () => {
    assert.deepEqual(
      detectRuntimeCoverageGaps([
        t(1, 0),
        t(2, MAX_PLAUSIBLE_TRANSITION_BLOCK_SPAN),
      ]),
      [],
    );
    assert.equal(
      detectRuntimeCoverageGaps([
        t(1, 0),
        t(2, MAX_PLAUSIBLE_TRANSITION_BLOCK_SPAN + 1),
      ]).length,
      1,
    );
  });

  test("honours an explicit maxSpan override", () => {
    assert.equal(detectRuntimeCoverageGaps([t(1, 0), t(2, 100)], 50).length, 1);
    assert.deepEqual(detectRuntimeCoverageGaps([t(1, 0), t(2, 100)], 150), []);
  });

  test("empty and single-entry timelines have no gaps", () => {
    assert.deepEqual(detectRuntimeCoverageGaps([]), []);
    assert.deepEqual(detectRuntimeCoverageGaps([t(440, 8_713_793)]), []);
  });
});

describe("buildRuntimeVersionHistory coverage disclosure", () => {
  test("coverage_complete is false and gaps are surfaced for a holey timeline", () => {
    const out = buildRuntimeVersionHistory([
      { spec_version: 101, block_number: 0, observed_at: 1 },
      { spec_version: 424, block_number: 8_599_188, observed_at: 2 },
    ]);
    assert.equal(out.coverage_complete, false);
    assert.equal(out.coverage_gaps.length, 1);
    // The bug this guards: a genesis-anchored floor reads as full history.
    assert.equal(out.coverage_from_block, 0);
  });

  test("coverage_complete is true for a dense timeline", () => {
    const out = buildRuntimeVersionHistory([
      { spec_version: 439, block_number: 8_713_025, observed_at: 1 },
      { spec_version: 440, block_number: 8_713_793, observed_at: 2 },
    ]);
    assert.equal(out.coverage_complete, true);
    assert.deepEqual(out.coverage_gaps, []);
  });

  test("an empty timeline is complete-by-vacuity with no gaps", () => {
    const out = buildRuntimeVersionHistory([]);
    assert.equal(out.coverage_complete, true);
    assert.deepEqual(out.coverage_gaps, []);
  });
});
