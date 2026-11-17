// The `Mirrors GET …` convention, which four gates read.
//
// It had no owner: four scripts each carried the pattern, and one of them
// (check-graphql-conformance) exported a helper the other three did not
// import. Every reader treats "no mirror declared" as "nothing to check", so
// a pattern that stopped matching would not fail -- each parity gate would
// pass over the fields it could no longer see. That is why this has tests of
// its own rather than being trusted to four call sites.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MIRRORS_GET, mirroredRoute } from "../scripts/lib/graphql-mirrors.ts";

describe("mirroredRoute", () => {
  test("reads the route out of a field description", () => {
    assert.equal(
      mirroredRoute("Mirrors GET /api/v1/chain/turnover"),
      "/api/v1/chain/turnover",
    );
    // Real descriptions have prose either side of the annotation.
    assert.equal(
      mirroredRoute("Network turnover. Mirrors GET /api/v1/chain/turnover."),
      "/api/v1/chain/turnover",
    );
  });

  test("a path parameter survives", () => {
    // Braces are not excluded by the character class, and parameterised routes
    // are the common case for per-subnet and per-account fields.
    assert.equal(
      mirroredRoute("Mirrors GET /api/v1/subnets/{netuid}/holders"),
      "/api/v1/subnets/{netuid}/holders",
    );
  });

  test("the captured route never ends with the sentence's full stop", () => {
    // Three of the four call sites defended against this with
    // `.replace(/\\.$/, "")`. The character class excludes `.`, so the strip
    // was unreachable -- asserted here so the strips stay gone.
    const route = mirroredRoute("Mirrors GET /api/v1/validators.");
    assert.equal(route, "/api/v1/validators");
    assert.doesNotMatch(route ?? "", /\\.$/);
  });

  test("no annotation is null, not an empty route", () => {
    // Every caller branches on this, and `""` would read as a route that
    // matches nothing rather than as an absent declaration.
    assert.equal(mirroredRoute("Just a description."), null);
    assert.equal(mirroredRoute(""), null);
    assert.equal(mirroredRoute(null), null);
    assert.equal(mirroredRoute(undefined), null);
    // A near-miss must not match either.
    assert.equal(mirroredRoute("Mirrors POST /api/v1/x"), null);
    assert.equal(mirroredRoute("Mirrors GET /api/v2/x"), null);
  });

  test("the pattern is exported for gates that need it directly", () => {
    assert.ok(MIRRORS_GET.test("Mirrors GET /api/v1/x"));
    assert.equal(MIRRORS_GET.global, false, "a global regex carries lastIndex");
  });
});
