// The blocks-summary projection reader (#9146).
//
// This lane stores the SHAPED CARD rather than rows, which makes one failure
// mode specific to it: a body whose `summary` is missing or malformed would,
// if passed through, surface as a summary with every field undefined rather
// than as an error. Each unusable-body shape therefore gets a decline test.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCKS_SUMMARY_PROJECTION_KEY,
  loadBlocksSummaryFromArtifact,
} from "../src/blocks-summary-artifact.ts";

// A COMPLETE card, as `buildBlocksSummary` emits it and as
// `BlocksSummaryArtifactSchema` publishes it.
//
// This fixture used to carry six of the twelve fields, and the reader's
// `body.summary as BlocksSummaryResult` cast let the partial card through --
// so the happy-path test asserted that exactly the body this file's header
// warns about round-trips "verbatim". #11418 validates the read against the
// route's own published schema, which is what makes the header's claim true.
const SUMMARY = {
  schema_version: 1,
  block_count: 5000,
  first_block: 8_755_000,
  last_block: 8_760_000,
  first_observed_at: "2026-08-03T06:00:00.000Z",
  last_observed_at: "2026-08-03T07:00:00.000Z",
  block_time: {
    count: 4999,
    mean_ms: 12_000,
    min_ms: 11_800,
    max_ms: 12_400,
    p50_ms: 12_000,
    p90_ms: 12_200,
  },
  throughput: {
    total_extrinsics: 21_000,
    total_events: 65_000,
    mean_extrinsics_per_block: 4.2,
    mean_events_per_block: 13,
    max_extrinsics_in_block: 19,
  },
  distinct_authors: 42,
  author_concentration: null,
  distinct_spec_versions: 2,
  latest_spec_version: 313,
};

/** An R2 double returning `body` for the projection key and null otherwise. */
function envWith(body: unknown, opts: { throws?: boolean } = {}) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        get(key: string) {
          keys.push(key);
          if (opts.throws) return Promise.reject(new Error("r2 down"));
          if (key !== BLOCKS_SUMMARY_PROJECTION_KEY) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ json: () => Promise.resolve(body) });
        },
      },
    } as unknown as Env,
  };
}

describe("loadBlocksSummaryFromArtifact", () => {
  test("returns the stored card verbatim", async () => {
    const { env, keys } = envWith({
      schema_version: 1,
      generated_at: "2026-08-03T07:05:00.000Z",
      row_count: 5000,
      summary: SUMMARY,
    });
    const out = await loadBlocksSummaryFromArtifact(env);
    // Verbatim: the lane already ran buildBlocksSummary, so re-shaping here
    // would be a second, divergent implementation of the same card.
    assert.deepEqual(out, SUMMARY);
    assert.deepEqual(keys, [BLOCKS_SUMMARY_PROJECTION_KEY]);
  });

  test("declines a summary missing fields the route publishes", async () => {
    // The failure this file's header names, now actually prevented. A card
    // without `throughput`/`block_time`/`author_concentration` would have been
    // served as a response whose OpenAPI-required fields read `undefined`;
    // declining sends the caller to its schema-stable zeroed card instead.
    const { schema_version, block_count } = SUMMARY;
    const { env } = envWith({
      schema_version: 1,
      summary: { schema_version, block_count },
    });
    assert.equal(await loadBlocksSummaryFromArtifact(env), null);
  });

  test("declines a summary carrying a field the route does not publish", async () => {
    // `.strict()` on the published schema: an extra key means the lane and the
    // contract have diverged, and the divergence must not reach callers.
    const { env } = envWith({
      schema_version: 1,
      summary: { ...SUMMARY, unexpected_field: 1 },
    });
    assert.equal(await loadBlocksSummaryFromArtifact(env), null);
  });

  test("declines on a null env", async () => {
    assert.equal(await loadBlocksSummaryFromArtifact(null), null);
  });

  test("declines with no archive binding", async () => {
    assert.equal(
      await loadBlocksSummaryFromArtifact({} as unknown as Env),
      null,
    );
  });

  test("declines when the object is missing", async () => {
    const env = {
      METAGRAPH_ARCHIVE: { get: () => Promise.resolve(null) },
    } as unknown as Env;
    assert.equal(await loadBlocksSummaryFromArtifact(env), null);
  });

  test.each([
    ["wrong schema_version", { schema_version: 2, summary: SUMMARY }],
    ["summary absent", { schema_version: 1 }],
    ["summary null", { schema_version: 1, summary: null }],
    ["body null", null],
  ] as [string, unknown][])(
    "declines when the artifact is unusable: %s",
    async (_label, body) => {
      const { env } = envWith(body);
      assert.equal(await loadBlocksSummaryFromArtifact(env), null);
    },
  );

  test("declines rather than throwing when the store errors", async () => {
    const { env } = envWith(
      { schema_version: 1, summary: SUMMARY },
      {
        throws: true,
      },
    );
    assert.equal(await loadBlocksSummaryFromArtifact(env), null);
  });
});
