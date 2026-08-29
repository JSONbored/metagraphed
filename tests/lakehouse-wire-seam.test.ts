// The warehouse and the wire share key sets on purpose, and must not converge.
//
// `schema-shape-duplicates` pins two pairs as coincident by design:
//
//   chain.blocks          <-> BlockSchema            (routes/blocks.ts)
//   chain.account_events  <-> AccountEventItemSchema (mcp-tools/shared.ts)
//
// A pin is only honest if the reason is checkable. The reason is that these are
// two LAYERS, not two copies: one declares what the warehouse holds, the other
// what we serve, and the formatting seam between them is where the types
// diverge. If someone "consolidated" them the pin would still pass -- the key
// sets would still match -- and the seam would be gone silently.
//
// So this asserts the DIVERGENCE, which is the thing a collapse would destroy.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  AccountEventsRowSchema,
  BlocksRowSchema,
} from "../schemas-src/lakehouse.ts";
import { BlockSchema } from "../schemas-src/routes/blocks.ts";
import { AccountEventItemSchema } from "../schemas-src/mcp-tools/shared.ts";

const keysOf = (schema: z.ZodType): string[] =>
  Object.keys(
    (schema as unknown as { shape: Record<string, unknown> }).shape,
  ).sort();

describe("the warehouse/wire seam is real, not a duplicate (#11008)", () => {
  test("blocks: stored columns stay aligned and response-only economics remain explicit", () => {
    const storedKeys = keysOf(BlocksRowSchema);
    const wireKeys = keysOf(BlockSchema);
    assert.deepEqual(
      storedKeys,
      [
        "block_number",
        "block_hash",
        "parent_hash",
        "author",
        "extrinsic_count",
        "event_count",
        "spec_version",
        "observed_at",
      ].sort(),
    );
    assert.deepEqual(
      wireKeys.filter((key) => !storedKeys.includes(key)),
      [
        "decode_status",
        "economic_activity_tao",
        "economic_activity_usd",
        "fee_tao",
        "issuance_tao",
        "native_transfer_tao",
        "stake_flow_tao",
        "subnet_ids",
        "tao_usd_basis",
        "tao_usd_block",
        "tao_usd_observed_at",
        "tao_usd_unavailable",
        "tip_tao",
        "usd_per_tao",
      ],
      "derived hot-tier and response-overlay fields must not masquerade as lakehouse columns",
    );
    // Stored: epoch millis. Served: an ISO 8601 string. A single declaration
    // cannot be both, which is why there are two.
    assert.equal(
      BlocksRowSchema.safeParse({ observed_at: 1_750_009_000_000 }).success,
      true,
    );
    assert.equal(
      BlocksRowSchema.safeParse({ observed_at: "2026-08-10T00:00:00Z" })
        .success,
      false,
    );
    const served = { ...blockWire(), observed_at: "2026-08-10T00:00:00.000Z" };
    assert.equal(BlockSchema.safeParse(served).success, true);
    assert.equal(
      BlockSchema.safeParse({ ...blockWire(), observed_at: 1_750_009_000_000 })
        .success,
      false,
      "the wire schema must NOT accept the stored form -- that is the seam",
    );
  });

  test("account events: amount_tao is a double as stored, opaque as served", () => {
    assert.deepEqual(
      keysOf(AccountEventsRowSchema),
      keysOf(AccountEventItemSchema),
    );
    assert.equal(
      AccountEventsRowSchema.safeParse({ amount_tao: 4.99 }).success,
      true,
    );
    assert.equal(
      AccountEventsRowSchema.safeParse({ amount_tao: "4.99" }).success,
      false,
      "the catalog says double; a string is a row R2 SQL cannot emit",
    );
    // The MCP surface deliberately does not type it -- both tiers feed it.
    assert.equal(
      AccountEventItemSchema.safeParse({ amount_tao: "4.99" }).success,
      true,
    );
  });
});

/** Every non-null column BlockSchema requires, so only observed_at varies. */
function blockWire() {
  return {
    block_number: 1,
    block_hash: "0xabc",
    parent_hash: "0xdef",
    author: "5F",
    extrinsic_count: 1,
    event_count: 1,
    spec_version: 1,
    decode_status: "unavailable",
    native_transfer_tao: null,
    stake_flow_tao: null,
    economic_activity_tao: null,
    fee_tao: null,
    tip_tao: null,
    issuance_tao: null,
    subnet_ids: [],
    economic_activity_usd: null,
    usd_per_tao: null,
    tao_usd_block: null,
    tao_usd_observed_at: null,
    tao_usd_basis: null,
  };
}
