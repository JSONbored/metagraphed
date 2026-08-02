// #9001: a label sink with unbounded cardinality is not merely expensive, it is
// unreadable -- the raw pathname produced a separate error-tracking fingerprint
// per block height in production, one occurrence each, which hides the pattern
// the fingerprint exists to surface.
//
// The two properties that matter pull against each other, so both are pinned:
// every identifier shape must be masked (or cardinality is unbounded), and
// nothing else may be (or two genuinely different routes silently merge into
// one label, which is far harder to notice than an unmasked one).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { maskRouteParams } from "../src/route-label.ts";

describe("maskRouteParams", () => {
  test("masks numeric ids", () => {
    assert.equal(
      maskRouteParams("/api/v1/subnets/123/conviction"),
      "/api/v1/subnets/:n/conviction",
    );
    // The live production case: every block height was its own fingerprint.
    assert.equal(
      maskRouteParams("/api/v1/blocks/8675340"),
      "/api/v1/blocks/:n",
    );
    assert.equal(
      maskRouteParams("/api/v1/blocks/8673156"),
      maskRouteParams("/api/v1/blocks/8648718"),
    );
  });

  test("masks 0x hashes", () => {
    assert.equal(
      maskRouteParams("/api/v1/extrinsics/0xdeadbeefcafe0123"),
      "/api/v1/extrinsics/:hash",
    );
  });

  test("masks ss58 addresses", () => {
    assert.equal(
      maskRouteParams(
        "/api/v1/accounts/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      ),
      "/api/v1/accounts/:ss58",
    );
  });

  // The #9001 addition. UUIDs are neither digits, nor 0x-prefixed, nor base58
  // (base58 has no dashes), so they fell through every existing pattern and
  // were emitted verbatim -- on two per-caller routes, so cardinality grew with
  // the number of users.
  test("masks UUIDs", () => {
    assert.equal(
      maskRouteParams(
        "/api/v1/webhooks/subscriptions/3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      ),
      "/api/v1/webhooks/subscriptions/:uuid",
    );
    assert.equal(
      maskRouteParams(
        "/api/v1/alerts/triggers/3F2504E0-4F89-11D3-9A0C-0305E82C3301",
      ),
      "/api/v1/alerts/triggers/:uuid",
    );
  });

  test("masks every identifier in a multi-segment path", () => {
    assert.equal(
      maskRouteParams("/api/v1/subnets/42/accounts/0xabcdef123456/events/7"),
      "/api/v1/subnets/:n/accounts/:hash/events/:n",
    );
  });

  // The other half. A false positive merges two real routes into one label,
  // which is worse than an unmasked segment because nothing looks wrong.
  test("leaves ordinary route segments alone", () => {
    assert.equal(maskRouteParams("/api/v1/subnets"), "/api/v1/subnets");
    assert.equal(
      maskRouteParams("/api/v1/subnets/conviction"),
      "/api/v1/subnets/conviction",
    );
    // A provider slug is not an identifier shape and must survive verbatim.
    assert.equal(
      maskRouteParams("/api/v1/providers/chutes/endpoints"),
      "/api/v1/providers/chutes/endpoints",
    );
  });

  test("does not mask short hex or a bare 0x", () => {
    // The hash pattern requires 6+ hex digits after 0x.
    assert.equal(maskRouteParams("/api/v1/x/0xabc"), "/api/v1/x/0xabc");
    assert.equal(maskRouteParams("/api/v1/x/0x"), "/api/v1/x/0x");
  });

  test("does not mask a UUID-length string that is not a UUID", () => {
    assert.equal(
      maskRouteParams("/api/v1/x/not-a-uuid-but-has-dashes-in-it-x"),
      "/api/v1/x/not-a-uuid-but-has-dashes-in-it-x",
    );
  });

  test("is idempotent, so a re-masked label is unchanged", () => {
    const once = maskRouteParams("/api/v1/subnets/42/badge.svg");
    assert.equal(maskRouteParams(once), once);
    assert.equal(once, "/api/v1/subnets/:n/badge.svg");
  });

  test("handles the root and empty paths without throwing", () => {
    assert.equal(maskRouteParams("/"), "/");
    assert.equal(maskRouteParams(""), "");
  });
});
