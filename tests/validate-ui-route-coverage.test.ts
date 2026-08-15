// The UI route-coverage ratchet (#10300).
//
// The matcher is the whole check, and it is easy to write in a way that quietly
// reports success. Both failure modes below actually happened while building
// it: a mangled character class cleared eleven routes that were genuinely
// unrendered-adjacent, and an unescaped `.` would clear every feed route by
// matching any character. So the tests are about the matcher being WRONG in
// the specific ways that look right.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MAX_UNREFERENCED_ROUTES,
  stripCodeComments,
  publishedRoutes,
  routePattern,
  unreferencedRoutes,
} from "../scripts/validate-ui-route-coverage.ts";

describe("matching a route against UI source", () => {
  test("a {token} matches a template-literal segment, the UI's actual idiom", () => {
    const src = "const u = `/api/v1/subnets/${netuid}/profile`;";
    assert.ok(routePattern("/api/v1/subnets/{netuid}/profile").test(src));
  });

  test("and a function call inside the segment", () => {
    // `/api/v1/accounts/${ss58PathSegment(ss58)}/balance` is real code in
    // queries.ts. A character class that excluded parentheses reported this
    // route unrendered while it was referenced twice.
    const src =
      "await apiFetch(`/api/v1/accounts/${ss58PathSegment(ss58)}/balance`)";
    assert.ok(routePattern("/api/v1/accounts/{ss58}/balance").test(src));
  });

  test("a {token} does NOT match across a slash", () => {
    // Otherwise `/api/v1/chain/holders` would be cleared by any longer path
    // that happens to contain it, and the check would measure nothing.
    assert.ok(
      !routePattern("/api/v1/accounts/{ss58}/balance").test(
        "/api/v1/accounts/a/b/balance",
      ),
    );
  });

  test("a literal dot is ESCAPED, so it cannot match any character", () => {
    // Every feed route has one. Unescaped, `gaps_atom` would clear
    // `/api/v1/feeds/gaps.atom` and the exclusion would be doing nothing.
    const p = routePattern("/api/v1/feeds/gaps.atom");
    assert.ok(p.test("/api/v1/feeds/gaps.atom"));
    assert.ok(!p.test("/api/v1/feeds/gapsXatom"));
  });

  test("the network-wide route is not cleared by its per-subnet twin", () => {
    // The near-miss #10300 documents, and the one my own first spot-check fell
    // for: six hits for `concentration/history`, all of them per-subnet.
    const src = "`/api/v1/subnets/${netuid}/concentration/history`";
    assert.ok(!routePattern("/api/v1/chain/concentration/history").test(src));
    assert.ok(
      routePattern("/api/v1/subnets/{netuid}/concentration/history").test(src),
    );
  });
});

describe("which routes are counted", () => {
  const oas = {
    paths: {
      "/api/v1/subnets": { get: {} },
      "/api/v1/feeds/gaps.atom": { get: {} },
      "/api/v1/{network}/subnets": { get: {} },
      "/api/v1/webhooks": { post: {} },
    },
  };

  test("feeds are excluded -- their consumer is external by design", () => {
    // Counting them measures the wrong thing: a feed reader renders them, not
    // our UI. Excluded by PREFIX so a new feed cannot silently raise the gap.
    assert.ok(!publishedRoutes(oas).includes("/api/v1/feeds/gaps.atom"));
  });

  test("network-prefixed testnet variants are excluded", () => {
    assert.ok(!publishedRoutes(oas).includes("/api/v1/{network}/subnets"));
  });

  test("non-GET routes are excluded", () => {
    assert.ok(!publishedRoutes(oas).includes("/api/v1/webhooks"));
  });

  test("what remains is the mainnet GET surface", () => {
    assert.deepEqual(publishedRoutes(oas), ["/api/v1/subnets"]);
  });
});

describe("the ratchet", () => {
  test("unrendered is the set with no reference anywhere", () => {
    const routes = ["/api/v1/a", "/api/v1/b"];
    assert.deepEqual(unreferencedRoutes(routes, "fetch('/api/v1/a')"), [
      "/api/v1/b",
    ]);
  });

  test("the ceiling is ZERO -- every published route is rendered (#10300)", () => {
    // It was 25, measured by running the check (the first value was 24,
    // arrived at by subtracting feeds from a total by hand, and wrong -- the
    // check caught its own author). #10300 closed the remaining gap, so this
    // stopped being a ratchet with slack in it and became a flat rule: a new
    // route that nothing renders fails CI.
    //
    // Asserted here as well as in the script so RAISING it is a visible test
    // change rather than a one-character edit. A ceiling that can drift up
    // quietly is not a ratchet.
    assert.equal(MAX_UNREFERENCED_ROUTES, 0);
  });

  test("an empty source means every route is unrendered, not zero", () => {
    // The direction that matters: a sweep that silently reads nothing must
    // report everything missing, not report success over an empty set.
    const routes = ["/api/v1/a", "/api/v1/b"];
    assert.deepEqual(unreferencedRoutes(routes, ""), routes);
  });
});

// Prose is not a consumer (#10517).
//
// The check matches route paths against a concatenation of apps/ui, so for a
// long time a docs table counted as a render -- and so did a code comment. Both
// are gone; what remains unseen is whether the reference is MOUNTED, which the
// failure messages no longer claim.
describe("stripCodeComments", () => {
  test("a route named only in a comment is not a reference", () => {
    const src = `// TODO: someday render /api/v1/chain/burn\nconst x = 1;`;
    assert.doesNotMatch(stripCodeComments(src), /chain\/burn/);
  });

  test("a route in a BLOCK comment is not a reference either", () => {
    const src = `/**\n * Fetches /api/v1/chain/burn eventually.\n */\nconst x = 1;`;
    assert.doesNotMatch(stripCodeComments(src), /chain\/burn/);
  });

  test("A ROUTE IN A TEMPLATE LITERAL SURVIVES -- this is how they are built", () => {
    // The failure that would be silent and total: this codebase composes paths
    // as `` `/api/v1/accounts/${ss58}/events` ``, so a stripper that does not
    // know backticks deletes the references the check exists to find, and every
    // one reads as a real gap.
    const src = "const p = `/api/v1/accounts/${ss58}/identity-history`;";
    assert.match(stripCodeComments(src), /identity-history/);
  });

  test("`https://` inside a string is not a comment", () => {
    // The classic naive-stripper bug, in all three quote forms.
    for (const q of ['"', "'", "`"]) {
      const src = `const u = ${q}https://api.metagraph.sh/api/v1/networks${q};`;
      assert.match(stripCodeComments(src), /api\.metagraph\.sh/, q);
    }
  });

  test("an escaped quote does not end the string early", () => {
    const src = 'const s = "a \\" /api/v1/chain/burn";';
    assert.match(stripCodeComments(src), /chain\/burn/);
  });

  test("code after a comment survives", () => {
    // Non-vacuity for the tests above: the stripper has to stop at the newline
    // rather than eating the rest of the file.
    const src = `// note\nconst p = "/api/v1/chain/burn";`;
    assert.match(stripCodeComments(src), /chain\/burn/);
  });
});
