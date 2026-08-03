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

const SUMMARY = {
  schema_version: 1,
  block_count: 5000,
  first_block: 8_755_000,
  last_block: 8_760_000,
  distinct_authors: 42,
  last_observed_at: "2026-08-03T07:00:00.000Z",
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
