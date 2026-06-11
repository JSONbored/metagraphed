import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { stripJsonComments } from "../scripts/lib.mjs";

describe("stripJsonComments", () => {
  test("strips line + block comments and trailing commas", () => {
    const input = `{
      // a line comment
      "a": 1, /* inline block */
      "b": 2,
    }`;
    assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 1, b: 2 });
  });

  test("preserves comment-like sequences inside string literals", () => {
    const input = `{ "url": "https://x.dev/a//b", "note": "uses /* and */ and //" }`;
    assert.deepEqual(JSON.parse(stripJsonComments(input)), {
      url: "https://x.dev/a//b",
      note: "uses /* and */ and //",
    });
  });

  test("regression: route glob '/api/*' + cron '*/2 * * * *' both survive", () => {
    // The `/*` ending "/api/*" and the `*/` inside "*/2 * * * *" must NOT be
    // spliced into a single block comment (the bug that ate the wrangler config).
    const input = `{
      "assets": { "run_worker_first": ["/api/*", "/rpc/*", "/metagraph/*"] },
      "vars": { "FLAG": "true" },
      "triggers": { "crons": ["*/2 * * * *", "0 * * * *"] }
    }`;
    const parsed = JSON.parse(stripJsonComments(input));
    assert.deepEqual(parsed.assets.run_worker_first, [
      "/api/*",
      "/rpc/*",
      "/metagraph/*",
    ]);
    assert.equal(parsed.vars.FLAG, "true");
    assert.deepEqual(parsed.triggers.crons, ["*/2 * * * *", "0 * * * *"]);
  });

  test("handles escaped quotes inside strings", () => {
    const input = `{ "q": "a \\"quoted\\" // not-a-comment" }`;
    assert.equal(
      JSON.parse(stripJsonComments(input)).q,
      'a "quoted" // not-a-comment',
    );
  });
});
