import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildBlocksSummary,
  loadBlocksSummary,
} from "../src/blocks-summary.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// Five blocks: 100-103 consecutive (12s apart), then a gap to 110. Two authors.
const ROWS = [
  {
    block_number: 100,
    author: "5Alice",
    extrinsic_count: 3,
    event_count: 10,
    spec_version: 200,
    observed_at: 1_750_000_000_000,
  },
  {
    block_number: 101,
    author: "5Alice",
    extrinsic_count: 2,
    event_count: 8,
    spec_version: 200,
    observed_at: 1_750_000_012_000,
  },
  {
    block_number: 102,
    author: "5Bob",
    extrinsic_count: 5,
    event_count: 20,
    spec_version: 200,
    observed_at: 1_750_000_024_000,
  },
  {
    block_number: 103,
    author: "5Alice",
    extrinsic_count: 1,
    event_count: 4,
    spec_version: 201,
    observed_at: 1_750_000_036_000,
  },
  {
    block_number: 110,
    author: null, // no author → excluded from authorship
    extrinsic_count: 0,
    event_count: 0,
    spec_version: 201,
    observed_at: 1_750_000_120_000,
  },
];

describe("buildBlocksSummary", () => {
  test("counts blocks + span and stamps first/last observed_at", () => {
    const out = buildBlocksSummary(ROWS);
    assert.equal(out.schema_version, 1);
    assert.equal(out.block_count, 5);
    assert.equal(out.first_block, 100);
    assert.equal(out.last_block, 110);
    assert.equal(
      out.first_observed_at,
      new Date(1_750_000_000_000).toISOString(),
    );
    assert.equal(
      out.last_observed_at,
      new Date(1_750_000_120_000).toISOString(),
    );
  });

  test("block-time uses only consecutive blocks (excludes the 103→110 gap)", () => {
    const out = buildBlocksSummary(ROWS);
    assert.equal(out.block_time.count, 3); // 100→101, 101→102, 102→103
    assert.equal(out.block_time.mean_ms, 12000);
    assert.equal(out.block_time.min_ms, 12000);
    assert.equal(out.block_time.max_ms, 12000);
    assert.equal(out.block_time.p50_ms, 12000);
    assert.equal(out.block_time.p90_ms, 12000);
  });

  test("block-time is null with fewer than two consecutive blocks", () => {
    assert.equal(
      buildBlocksSummary([
        { block_number: 5, observed_at: 1 },
        { block_number: 9, observed_at: 100 }, // non-consecutive → no interval
      ]).block_time,
      null,
    );
  });

  test("block-time skips a non-positive interval (clock regression)", () => {
    const out = buildBlocksSummary([
      { block_number: 1, observed_at: 1_000 },
      { block_number: 2, observed_at: 1_000 }, // equal → not > prev → skipped
      { block_number: 3, observed_at: 3_000 }, // +2000 → counted
    ]);
    assert.equal(out.block_time.count, 1);
    assert.equal(out.block_time.mean_ms, 2000);
  });

  test("nearest-rank p50/p90 over the interval spread", () => {
    const out = buildBlocksSummary([
      { block_number: 1, observed_at: 0 },
      { block_number: 2, observed_at: 10 }, // +10
      { block_number: 3, observed_at: 40 }, // +30
      { block_number: 4, observed_at: 90 }, // +50
      { block_number: 5, observed_at: 160 }, // +70
    ]);
    // intervals [10,30,50,70] → p50 rank ceil(0.5·4)=2 → 30; p90 rank 4 → 70
    assert.equal(out.block_time.count, 4);
    assert.equal(out.block_time.p50_ms, 30);
    assert.equal(out.block_time.p90_ms, 70);
  });

  test("throughput totals, per-block means, and max", () => {
    const out = buildBlocksSummary(ROWS);
    assert.equal(out.throughput.total_extrinsics, 11); // 3+2+5+1+0
    assert.equal(out.throughput.total_events, 42); // 10+8+20+4+0
    assert.equal(out.throughput.mean_extrinsics_per_block, 2.2);
    assert.equal(out.throughput.mean_events_per_block, 8.4);
    assert.equal(out.throughput.max_extrinsics_in_block, 5);
  });

  test("author concentration is over each author's block count", () => {
    const out = buildBlocksSummary(ROWS);
    assert.equal(out.distinct_authors, 2); // Alice + Bob (null excluded)
    assert.equal(out.author_concentration.holders, 2);
    assert.equal(out.author_concentration.total, 4); // Alice 3 + Bob 1
    assert.equal(out.author_concentration.nakamoto_coefficient, 1); // Alice > 50%
  });

  test("spec-version spread + latest at the newest block", () => {
    const out = buildBlocksSummary(ROWS);
    assert.equal(out.distinct_spec_versions, 2); // 200, 201
    assert.equal(out.latest_spec_version, 201); // block 110
  });

  test("drops rows with a non-numeric block_number; coerces numeric strings", () => {
    const out = buildBlocksSummary([
      {
        block_number: "100",
        author: "5A",
        extrinsic_count: "2",
        observed_at: "5",
      },
      { block_number: "", observed_at: 1 }, // blank → dropped (not block 0)
      { block_number: null }, // dropped
      { block_number: "abc" }, // dropped
      { block_number: 1.5 }, // non-integer number → dropped
      { block_number: -1 }, // negative number → dropped
    ]);
    assert.equal(out.block_count, 1);
    assert.equal(out.first_block, 100);
    assert.equal(out.throughput.total_extrinsics, 2); // "2" coerced
  });

  test("junk count cells contribute 0, never poison the totals", () => {
    const out = buildBlocksSummary([
      { block_number: 1, extrinsic_count: "junk", event_count: null },
    ]);
    assert.equal(out.throughput.total_extrinsics, 0);
    assert.equal(out.throughput.total_events, 0);
  });

  test("blocks with no author/spec/observed_at stay schema-stable", () => {
    const out = buildBlocksSummary([{ block_number: 1 }, { block_number: 2 }]);
    assert.equal(out.block_count, 2);
    assert.equal(out.distinct_authors, 0);
    assert.equal(out.author_concentration, null);
    assert.equal(out.distinct_spec_versions, 0);
    assert.equal(out.latest_spec_version, null);
    assert.equal(out.first_observed_at, null); // no observed_at cells
    assert.equal(out.last_observed_at, null);
    assert.equal(out.block_time, null);
  });

  test("drops out-of-range observed_at cells instead of throwing", () => {
    const observed = 1_750_000_000_000;
    const out = buildBlocksSummary([
      { block_number: 1, observed_at: "8640000000000001" },
      { block_number: 2, observed_at: observed },
    ]);
    assert.equal(out.block_count, 2);
    assert.equal(out.first_observed_at, new Date(observed).toISOString());
    assert.equal(out.last_observed_at, new Date(observed).toISOString());
    assert.equal(out.block_time, null);
  });

  test("cold/empty store → schema-stable zeroed card", () => {
    const out = buildBlocksSummary([]);
    assert.equal(out.block_count, 0);
    assert.equal(out.first_block, null);
    assert.equal(out.block_time, null);
    assert.equal(out.throughput, null);
    assert.equal(out.distinct_authors, 0);
    assert.equal(out.author_concentration, null);
    assert.equal(out.latest_spec_version, null);
  });

  test("null-safe on junk rows", () => {
    const out = buildBlocksSummary("nope");
    assert.equal(out.block_count, 0);
    assert.equal(out.throughput, null);
  });

  test("loadBlocksSummary reads recent blocks newest-first and shapes them", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadBlocksSummary(d1);
    assert.match(seen.sql, /FROM blocks ORDER BY block_number DESC LIMIT/);
    assert.equal(out.block_count, 5);
    assert.equal(out.distinct_authors, 2);
  });
});

describe("GET /api/v1/blocks/summary", () => {
  function blocksEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM blocks/.test(sql) ? rows : [],
                }),
            }),
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/blocks/summary${q}`);

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(req("?window=7d"), blocksEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("is not parsed as a block {ref} detail route", async () => {
    // "summary" must hit the summary handler, not handleBlock("summary").
    const res = await handleRequest(req(), blocksEnv(ROWS), {});
    const body = await res.json();
    assert.equal("block_count" in body.data, true);
    assert.equal("ref" in body.data, false);
  });
});
