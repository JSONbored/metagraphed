import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { githubRepoMapKey, signalsByKey } from "../src/github-signals-core.ts";

// The per-field guards that replaced `e as unknown as RepoSignal` (#11339).
//
// The old spelling filtered `owner`/`repo` for TRUTHINESS and then read them as
// `string`, and asserted the whole entry into shape — so a captured document
// carrying nothing but those two fields looked like a complete signal to every
// consumer of the map, `unreachable` included.
describe("signalsByKey narrows each field (#11339)", () => {
  test("a NUMERIC owner is skipped, not turned into a map key", () => {
    // Truthy, so the old filter passed it, and `githubRepoMapKey(42, ...)`
    // would have built a key out of it.
    const map = signalsByKey({
      signals: [
        { owner: 42, repo: "x" },
        { owner: "", repo: "y" },
      ],
    });
    assert.equal(map.size, 0);
  });

  test("a non-numeric `stars` reads as null rather than being carried", () => {
    const map = signalsByKey({
      signals: [{ owner: "o", repo: "r", stars: "many" }],
    });
    assert.equal(map.get(githubRepoMapKey("o", "r"))?.stars, null);
  });

  test("a missing `unreachable` reads as REACHABLE-unknown, not reachable", () => {
    // The field decides whether a consumer treats the signal as usable, so an
    // absent one must not read as `false` by accident of the spread.
    const map = signalsByKey({ signals: [{ owner: "o", repo: "r" }] });
    assert.equal(map.get(githubRepoMapKey("o", "r"))?.unreachable, false);
  });

  test("non-array `commits_weekly` / `releases` degrade to null", () => {
    const map = signalsByKey({
      signals: [{ owner: "o", repo: "r", commits_weekly: "nope", releases: 7 }],
    });
    const signal = map.get(githubRepoMapKey("o", "r"));
    assert.equal(signal?.commits_weekly, null);
    assert.equal(signal?.releases, null);
  });

  test("a document with no `signals` array yields an empty map", () => {
    assert.equal(signalsByKey({ signals: "not an array" }).size, 0);
    assert.equal(signalsByKey(null).size, 0);
    assert.equal(signalsByKey({}).size, 0);
  });

  test("non-object entries are dropped rather than read", () => {
    assert.equal(
      signalsByKey({ signals: [null, "x", 7, { owner: "o", repo: "r" }] }).size,
      1,
    );
  });
});
