// The published-vocabulary gate (#10951), driven over inputs whose answer is
// known by construction.
//
// The point of these is the FAILING direction. A gate asserting "zero D1 in the
// published contract" passes trivially on a tree that already has zero, and
// would go on passing if `findViolations` were `return []`. Each test below
// therefore seeds the violation it claims to catch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  ALLOWED_PHRASES,
  RETIRED_STORES,
  findViolations,
  staleAllowances,
} from "../scripts/validate-retired-store-vocabulary.ts";
import { repoRoot } from "../scripts/lib.ts";

const published = (rel: string): string =>
  readFileSync(path.join(repoRoot, rel), "utf8");

describe("findViolations catches a retired store in published text", () => {
  test("a route description that claims a live D1 tier fails", () => {
    const seeded = JSON.stringify({
      routes: [
        { path: "/api/v1/x", description: "Served live from D1 at /api/v1/x." },
      ],
    });
    const found = findViolations("seeded.json", seeded);
    assert.equal(found.length, 1);
    assert.equal(found[0].store, "D1");
    assert.match(found[0].context, /Served live from D1/);
  });

  test("every occurrence is reported, not just the first", () => {
    // The real defect was 49 descriptions at once. A gate that stops at the
    // first one turns a sweep into 49 sequential CI runs.
    const seeded =
      "computed live from D1. served live from D1. two bulk D1 reads.";
    assert.equal(findViolations("seeded", seeded).length, 3);
  });

  test("`d1` as a lookback key or flag value is NOT a violation", () => {
    // REALIZED_RETURN_WINDOWS = { d1: 1, d7: 7, d30: 30 } and the legacy "d1"
    // tier-flag value are vocabulary, not the database. A rename there nulled
    // every validator's 1-day realized return once already, so the gate must
    // not push anyone toward touching them.
    const seeded = JSON.stringify({ windows: { d1: 1, d7: 7 }, source: "d1" });
    assert.deepEqual(findViolations("seeded.json", seeded), []);
  });

  test("an allowed phrase passes, but only verbatim", () => {
    const allowed = "Every aggregate is null on a cold retired-D1 store.";
    assert.deepEqual(findViolations("seeded", allowed), []);
    // The same words in a live claim must still fail -- this is what an exact
    // string buys over a /retired/ carve-out.
    const smuggled = "Served live from D1 (the retired tier).";
    assert.equal(findViolations("seeded", smuggled).length, 1);
  });
});

describe("the allowance list cannot outlive its text", () => {
  test("an allowance matching nothing published is reported", () => {
    const stale = staleAllowances(["nothing here"], ["a phrase nobody uses"]);
    assert.deepEqual(stale, ["a phrase nobody uses"]);
  });

  test("an allowance still present is not reported", () => {
    assert.deepEqual(
      staleAllowances(["... a cold retired-D1 store ..."], ALLOWED_PHRASES),
      [],
    );
  });
});

describe("the gate agrees with the tree it guards", () => {
  test("the published contract names no retired store today", () => {
    // The positive control for the whole file: if this ever fails, the seeded
    // tests above are still meaningful but the tree has regressed.
    const texts = [
      published("public/metagraph/contracts.json"),
      published("public/metagraph/openapi.json"),
    ];
    const found = texts.flatMap((t, i) => findViolations(String(i), t));
    assert.deepEqual(
      found.map((v) => v.context),
      [],
    );
  });

  test("every declared allowance is actually in use", () => {
    const texts = [
      published("public/metagraph/contracts.json"),
      published("public/metagraph/openapi.json"),
    ];
    assert.deepEqual(staleAllowances(texts), []);
  });

  test("each retired store declares when it went", () => {
    // A name with no date is a name nobody can date-check against the tree.
    for (const store of RETIRED_STORES) {
      assert.ok(store.retired, `${store.name} needs its retirement recorded`);
      assert.ok(
        store.pattern.global,
        `${store.name}'s pattern must be /g to find all`,
      );
    }
  });
});
