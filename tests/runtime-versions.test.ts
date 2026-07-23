import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  buildRuntimeVersionHistory,
  formatRuntimeTransition,
  loadRuntimeVersionHistory,
} from "../src/runtime-versions.ts";
import { handleRequest } from "../workers/api.mjs";
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
// own canned rows. Mirrors hyperparamsEnv in tests/subnet-hyperparams.test.mjs,
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
      runtimeEnv([]),
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
      runtimeEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("testnet has no variant (mainnet-only blocks D1 tier)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/runtime"),
      runtimeEnv([]),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
