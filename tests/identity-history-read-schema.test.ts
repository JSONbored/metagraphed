// The read-tolerant identity timelines (#11339).
//
// Both composers used to declare `Promise<Row>`, reach it with
// `as unknown as Row`, and have every REST caller cast it straight back with
// `as unknown as ReturnType<typeof buildSubnetIdentityHistory>` -- a round trip
// through `Row` that discarded the type at one end and re-asserted it at the
// other, with nothing checking in between.
//
// Replacing that with a parse is only safe if it is the RIGHT parse. The strict
// schema is the RESPONSE contract. Reading a TIER through it would reject a
// whole answer over one absent key, fall through to the empty builder, and
// publish "no identity has ever changed" for most of the network -- which is
// the exact failure the frozen export exists to prevent.
//
// So these pin that the tolerance goes one way only.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SubnetIdentityHistoryArtifactSchema,
  SubnetIdentityHistoryReadSchema,
} from "../schemas-src/routes/subnet-identity-history.ts";
import {
  ChainIdentityHistoryArtifactSchema,
  ChainIdentityHistoryReadSchema,
} from "../schemas-src/routes/chain-identity-history.ts";

/** The live /api/v1/subnets/64/identity-history body, 2026-08-15. */
const SERVED = {
  schema_version: 1,
  netuid: 64,
  entry_count: 1,
  limit: 2,
  offset: 0,
  next_cursor: null,
  entries: [
    {
      block_number: 8823651,
      observed_at: "2026-08-11T13:15:49.023Z",
      subnet_name: "Chutes",
      symbol: null,
      description: "Breakthrough Serverless Compute for AI, At Scale.",
      github_repo: "https://github.com/chutesai/chutes",
      subnet_url: "https://chutes.ai/",
      discord: "https://discord.gg/chutes",
      logo_url: "https://storage.googleapis.com/chutes-random/logo-chutes.png",
      identity_hash:
        "53658340a2d7a18b5d7f290ce32efa43df2cebcc740755fc1536fe5d2584ea21",
    },
  ],
};

describe("SubnetIdentityHistoryReadSchema", () => {
  test("the LIVE SERVED BODY parses under both schemas", () => {
    // Verified against production before the assertion was replaced: the read
    // schema loosens a contract that already held rather than papering over a
    // drift that was already there.
    assert.equal(
      SubnetIdentityHistoryArtifactSchema.safeParse(SERVED).success,
      true,
    );
    assert.equal(
      SubnetIdentityHistoryReadSchema.safeParse(SERVED).success,
      true,
    );
  });

  test("A TIER ANSWERING A SUBSET IS STILL AN ANSWER", () => {
    // The frozen export carries what it carries. Under the strict schema this
    // is rejected, the cascade falls through, and the route publishes an empty
    // timeline for a subnet whose name demonstrably changed.
    const partial = {
      schema_version: 1,
      netuid: 64,
      entry_count: 1,
      entries: [{ subnet_name: "Frozen Name" }],
    };
    assert.equal(
      SubnetIdentityHistoryArtifactSchema.safeParse(partial).success,
      false,
    );
    assert.equal(
      SubnetIdentityHistoryReadSchema.safeParse(partial).success,
      true,
    );
  });

  test("A NEW PRODUCER FIELD DOES NOT EMPTY THE ROUTE", () => {
    const extra = {
      ...SERVED,
      SHIPPED_BEFORE_THIS_FILE_KNEW: 1,
      entries: [{ ...SERVED.entries[0], ALSO_NEW: 2 }],
    };
    assert.equal(
      SubnetIdentityHistoryReadSchema.safeParse(extra).success,
      true,
    );
  });

  test("THE TYPE STAYS PINNED -- the half worth keeping", () => {
    // Tolerating absence is not the same as tolerating nonsense. A tier
    // answering `entry_count: "abc"` has not answered.
    const wrong = { ...SERVED, entry_count: "not a number" };
    assert.equal(
      SubnetIdentityHistoryReadSchema.safeParse(wrong).success,
      false,
    );
  });

  test("a wrong type INSIDE an entry is caught too", () => {
    const wrong = {
      ...SERVED,
      entries: [{ ...SERVED.entries[0], block_number: "eight million" }],
    };
    assert.equal(
      SubnetIdentityHistoryReadSchema.safeParse(wrong).success,
      false,
    );
  });

  test("a non-object is rejected", () => {
    for (const v of [null, [], "x", 7]) {
      assert.equal(
        SubnetIdentityHistoryReadSchema.safeParse(v).success,
        false,
        JSON.stringify(v),
      );
    }
  });
});

describe("ChainIdentityHistoryReadSchema", () => {
  const FEED = {
    schema_version: 1,
    count: 1,
    subnet_count: 1,
    changes: [
      {
        netuid: 1,
        observed_at: "2026-08-11T13:15:49.023Z",
        identity_hash: "a",
      },
    ],
  };

  test("a full feed parses under both", () => {
    assert.equal(
      ChainIdentityHistoryArtifactSchema.safeParse(FEED).success,
      true,
    );
    assert.equal(ChainIdentityHistoryReadSchema.safeParse(FEED).success, true);
  });

  test("THE FROZEN EXPORT'S MINIMAL CHANGE IS STILL AN ANSWER", () => {
    const minimal = {
      schema_version: 1,
      count: 1,
      subnet_count: 1,
      changes: [{ netuid: 1, subnet_name: "Frozen Name" }],
    };
    assert.equal(
      ChainIdentityHistoryArtifactSchema.safeParse(minimal).success,
      false,
    );
    assert.equal(
      ChainIdentityHistoryReadSchema.safeParse(minimal).success,
      true,
    );
  });

  test("a wrong type still fails", () => {
    assert.equal(
      ChainIdentityHistoryReadSchema.safeParse({ ...FEED, count: "one" })
        .success,
      false,
    );
  });
});
