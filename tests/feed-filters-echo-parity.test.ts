// The feed's echoed filters and the request vocabulary cannot drift apart.
//
// `schema-shape-duplicates` used to carry a ceiling of 1 for this pair: the
// same four keys declared in `route-queries.ts` (what a caller may SEND) and in
// `mcp-tools/feed.ts` (what the response ECHOES BACK). They are not one
// vocabulary -- `since` parses a bare date on the way in and is a plain string
// on the way out, `limit` carries the route's CEILING on the way in and is a
// plain int on the way out -- so collapsing them would either apply request
// validation to a nullable echo or drop the ceiling.
//
// A numeric ceiling said "we tolerate one pair" without saying which, and
// without stopping it drifting. This says WHICH, and stops it: the key sets
// must match, so a filter added to the request and forgotten in the echo fails
// here. That is the whole risk the duplicate gate exists to catch, closed
// directly rather than counted.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { FEED_QUERY_SCHEMAS } from "../schemas-src/route-queries.ts";
import { GetFeedOutputSchema } from "../schemas-src/mcp-tools/feed.ts";

const keysOf = (schema: z.ZodType): string[] => {
  let node = schema as unknown as {
    shape?: Record<string, unknown>;
    unwrap?: () => z.ZodType;
  };
  while (!node.shape && typeof node.unwrap === "function") {
    node = node.unwrap() as typeof node;
  }
  assert.ok(node.shape, "expected an object schema under the wrappers");
  return Object.keys(node.shape).sort();
};

describe("the feed echo mirrors the request vocabulary (#11008)", () => {
  test("the echoed filters declare exactly the keys a caller may send", () => {
    const echo = (
      GetFeedOutputSchema.shape as unknown as Record<string, z.ZodType>
    ).filters;
    assert.ok(echo, "GetFeedOutput must carry the filters it applied");
    assert.deepEqual(keysOf(echo), keysOf(FEED_QUERY_SCHEMAS.common));
  });

  test("the request side keeps the constraints the echo deliberately drops", () => {
    // Guards the guard: if these ever became the same declaration, the parity
    // above would still pass while the route lost its ceiling. The POINT of
    // keeping two is that the request side validates and the echo does not.
    const request = FEED_QUERY_SCHEMAS.common;
    assert.equal(request.safeParse({ limit: 1_000_000 }).success, false);
    const echo = (
      GetFeedOutputSchema.shape as unknown as Record<string, z.ZodType>
    ).filters as z.ZodType;
    assert.equal(
      (
        echo as unknown as { safeParse: (v: unknown) => { success: boolean } }
      ).safeParse({ limit: 1_000_000 }).success,
      true,
      "the echo reports what was applied; it does not re-validate it",
    );
  });
});
