// Same family contract as chain-transfers-artifact.test.ts: the stored
// per-UTC-day rows flow VERBATIM into the shared buildChainActivity
// formatter (which owns the day merge, ordering, and success-rate math), and
// anything that is not the artifact the lane wrote declines rather than
// half-serving. Also pins epochDayIso — the single definition of the lane's
// UTC day boundary shared with the writer.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_ACTIVITY_PROJECTION_KEY,
  epochDayIso,
  chainActivityCoverageIsCurrent,
  loadChainActivityFromArtifact,
} from "../src/chain-activity-artifact.ts";

const NEWEST = 1785680000000;

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 3,
    windows: {
      "7d": {
        days: 7,
        extrinsic_rows: [
          {
            day: "2026-08-02",
            extrinsic_count: "100",
            successful_extrinsics: "97",
            unique_signers: "9",
          },
          {
            day: "2026-08-01",
            extrinsic_count: "50",
            successful_extrinsics: "50",
            unique_signers: 0,
          },
        ],
        block_rows: [
          { day: "2026-08-02", block_count: "7200", event_count: "40000" },
        ],
        newest_observed: NEWEST,
      },
      "30d": {
        days: 30,
        extrinsic_rows: [
          {
            day: "2026-07-10",
            extrinsic_count: "10",
            successful_extrinsics: "10",
            unique_signers: "2",
          },
        ],
        block_rows: [],
        newest_observed: null,
      },
    },
  };
}

function bucketWith(body: unknown, opts: { missing?: boolean } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (opts.missing) return null;
          return { json: async () => body };
        },
      },
    } as unknown as Env,
  };
}

describe("epochDayIso", () => {
  test("renders the same UTC 'YYYY-MM-DD' label to_char produced for the same rows", () => {
    const day = Math.floor(Date.UTC(2026, 7, 2, 12, 0, 0) / 86400000);
    assert.equal(epochDayIso(day), "2026-08-02");
    assert.equal(epochDayIso(String(day)), "2026-08-02");
    assert.equal(epochDayIso(0), "1970-01-01");
  });

  test("anything that is not a renderable non-negative day index is null", () => {
    assert.equal(epochDayIso("bogus"), null);
    assert.equal(epochDayIso(null), null);
    assert.equal(epochDayIso("  "), null);
    assert.equal(epochDayIso(-1), null);
    // Finite and non-negative, but past the JS Date range once scaled to ms.
    assert.equal(epochDayIso(1e12), null);
  });
});

describe("chainActivityCoverageIsCurrent", () => {
  const current = {
    newest_observed: Date.parse("2026-08-02T14:00:00.000Z"),
    extrinsic_rows: [{ day: "2026-08-01" }, { day: "2026-08-02" }],
    block_rows: [{ day: "2026-08-01" }, { day: "2026-08-02" }],
  };

  test("accepts current source data with the last complete UTC day on both tables", () => {
    assert.equal(
      chainActivityCoverageIsCurrent(current, "2026-08-02T15:00:00.000Z", {
        requireCompleteDay: true,
      }),
      true,
    );
  });

  test("rejects a fresh publication over stale decoded rows", () => {
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, newest_observed: Date.parse("2026-07-29T12:00:00Z") },
        "2026-08-02T15:00:00.000Z",
      ),
      false,
    );
  });

  test("rejects unreadable publication and source clocks", () => {
    assert.equal(chainActivityCoverageIsCurrent(current, "not-a-date"), false);
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, newest_observed: "not-a-number" },
        "2026-08-02T15:00:00.000Z",
      ),
      false,
    );
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, newest_observed: null },
        "2026-08-02T15:00:00.000Z",
      ),
      false,
    );
  });

  test("rejects a source that has not crossed today's UTC boundary", () => {
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, newest_observed: Date.parse("2026-08-01T23:59:00Z") },
        "2026-08-02T00:10:00.000Z",
      ),
      false,
    );
  });

  test("requires the last complete day from both source tables for a new write", () => {
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, block_rows: [{ day: "2026-08-02" }] },
        "2026-08-02T15:00:00.000Z",
        { requireCompleteDay: true },
      ),
      false,
    );
    assert.equal(
      chainActivityCoverageIsCurrent(
        { ...current, extrinsic_rows: [{ day: "2026-08-02" }] },
        "2026-08-02T15:00:00.000Z",
        { requireCompleteDay: true },
      ),
      false,
    );
  });
});

describe("loadChainActivityFromArtifact", () => {
  test("serves the default window through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainActivityFromArtifact(env, {});
    assert.equal(gets[0], CHAIN_ACTIVITY_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.day_count, 2);
    // Newest day first, extrinsic + block tiers merged by day.
    assert.equal(data!.days[0]!.day, "2026-08-02");
    assert.equal(data!.days[0]!.extrinsic_count, 100);
    assert.equal(data!.days[0]!.block_count, 7200);
    assert.equal(data!.days[0]!.event_count, 40000);
    assert.equal(data!.days[0]!.unique_signers, 9);
    assert.equal(data!.days[0]!.success_rate, 0.97);
    // A day only the extrinsics tier saw keeps schema-stable zeros.
    assert.equal(data!.days[1]!.day, "2026-08-01");
    assert.equal(data!.days[1]!.block_count, 0);
    assert.equal(data!.days[1]!.success_rate, 1);
    // The stored blocks MAX(observed_at) surfaces as the same ISO freshness
    // signal the live tier reported.
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("a precomputed window with no source freshness declines", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainActivityFromArtifact(env, { window: "30d" });
    assert.equal(data, null);
  });

  test("a newly published card over stale decoded rows declines", async () => {
    const body = artifact();
    body.generated_at = "2026-08-06T12:00:00.000Z";
    const { env } = bucketWith(body);
    assert.equal(await loadChainActivityFromArtifact(env, {}), null);
  });

  test("a legacy card without generated_at remains readable until its next rewrite", async () => {
    const { generated_at: _generatedAt, ...legacy } = artifact();
    const { env } = bucketWith(legacy);
    const data = await loadChainActivityFromArtifact(env, {});
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainActivityFromArtifact(env, { window: "90d" }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainActivityFromArtifact(env, { window: "30d" }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(await loadChainActivityFromArtifact({} as never, {}), null);
    assert.equal(await loadChainActivityFromArtifact(null, {}), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainActivityFromArtifact(env, {}), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      {
        schema_version: 1,
        windows: { "7d": { extrinsic_rows: "no", block_rows: [] } },
      },
      {
        schema_version: 1,
        windows: { "7d": { extrinsic_rows: [], block_rows: "no" } },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainActivityFromArtifact(env, {}),
        null,
        JSON.stringify(body),
      );
    }
  });

  test("a throwing store declines instead of failing the request", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("r2 down");
        },
      },
    } as unknown as Env;
    assert.equal(await loadChainActivityFromArtifact(env, {}), null);
  });
});
