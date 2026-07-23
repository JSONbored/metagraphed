import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildValidatorHistory } from "../src/validator-history.ts";
import type { Row } from "./row-type.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the
// SQL — mirrors historyEnv in tests/neuron-history.test.mjs.
function historyEnv(rows: Row[], captured: Row = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        captured.sql = sql;
        return {
          bind(...params: unknown[]) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

const ctx = { waitUntil: (p: Promise<unknown>) => p };

describe("buildValidatorHistory", () => {
  test("shapes per-day aggregates", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          subnet_count: 3,
          total_stake_tao: 1000,
          total_emission_tao: 12.3,
        },
      ],
      HOTKEY,
      { window: "90d" },
    ) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.hotkey, HOTKEY);
    assert.equal(out.window, "90d");
    assert.equal(out.point_count, 1);
    assert.equal(out.points[0].snapshot_date, "2026-06-20");
    assert.equal(out.points[0].subnet_count, 3);
    assert.equal(out.points[0].total_stake_tao, 1000);
    assert.equal(out.points[0].total_emission_tao, 12.3);
  });

  test("computes rewards_per_1000_tao from the day's totals", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          subnet_count: 1,
          total_stake_tao: 2000,
          total_emission_tao: 10,
        },
      ],
      HOTKEY,
    ) as Row;
    // 10 / 2000 * 1000 = 5
    assert.equal(out.points[0].rewards_per_1000_tao, 5);
  });

  test("rewards_per_1000_tao is null when stake is zero, negative, or absent", () => {
    for (const total_stake_tao of [0, -5, null, undefined]) {
      const out = buildValidatorHistory(
        [
          {
            snapshot_date: "2026-06-20",
            total_stake_tao,
            total_emission_tao: 10,
          },
        ],
        HOTKEY,
      ) as Row;
      assert.equal(
        out.points[0].rewards_per_1000_tao,
        null,
        `total_stake_tao=${JSON.stringify(total_stake_tao)}`,
      );
    }
  });

  test("rewards_per_1000_tao is null when emission is absent, even with real stake", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          total_stake_tao: 100,
          total_emission_tao: null,
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].rewards_per_1000_tao, null);
  });

  test("rounds the per-day TAO sums to drop float noise", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-20",
          total_stake_tao: 0.1 + 0.2, // 0.30000000000000004
          total_emission_tao: 1.005 + 2.005, // 3.0100000000000002
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].total_stake_tao, 0.3);
    assert.equal(out.points[0].total_emission_tao, 3.01);
  });

  test("a null SUM (cold/sparse day) stays null, never coerced to 0", () => {
    const out = buildValidatorHistory(
      [
        {
          snapshot_date: "2026-06-19",
          total_stake_tao: null,
          total_emission_tao: null,
        },
      ],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
  });

  test("defaults window to null and every aggregate to null on a sparse row", () => {
    const out = buildValidatorHistory(
      [{ snapshot_date: "2026-06-20" }],
      HOTKEY,
    ) as Row;
    assert.equal(out.window, null);
    assert.equal(out.points[0].subnet_count, null);
    assert.equal(out.points[0].total_stake_tao, null);
    assert.equal(out.points[0].total_emission_tao, null);
    assert.equal(out.points[0].rewards_per_1000_tao, null);
  });

  test("coerces string-typed subnet_count to an integer", () => {
    const out = buildValidatorHistory(
      [{ snapshot_date: "2026-06-20", subnet_count: "3" }],
      HOTKEY,
    ) as Row;
    assert.equal(out.points[0].subnet_count, 3);
  });

  test("rejects an invalid subnet_count to null (negative, fractional, non-numeric, blank)", () => {
    for (const subnet_count of [-1, 1.5, "abc", "", "   "]) {
      const out = buildValidatorHistory(
        [{ snapshot_date: "2026-06-20", subnet_count }],
        HOTKEY,
      ) as Row;
      assert.equal(
        out.points[0].subnet_count,
        null,
        `subnet_count=${JSON.stringify(subnet_count)}`,
      );
    }
  });

  test("drops malformed (non-object) rows and the count tracks the array", () => {
    const out = buildValidatorHistory(
      [
        null,
        undefined,
        "nope",
        { snapshot_date: "2026-06-20" },
      ] as unknown as Row[],
      HOTKEY,
    ) as Row;
    assert.equal(out.point_count, 1);
    assert.equal(out.points.length, 1);
  });

  test("is cold-safe for non-array/empty input", () => {
    for (const rows of [[], null, undefined]) {
      const out = buildValidatorHistory(rows, HOTKEY) as Row;
      assert.equal(out.hotkey, HOTKEY);
      assert.equal(out.point_count, 0);
      assert.deepEqual(out.points, []);
    }
  });
});

describe("GET /api/v1/validators/{hotkey}/history via the Worker", () => {
  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history?window=400d`,
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history?foo=bar`,
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/validators/${HOTKEY}/history`,
      ),
      historyEnv([]),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.point_count, 0);
  });
});
