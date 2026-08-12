// The identifier brands, and proof the transpositions they exist to stop no
// longer compile (#10866).
//
// The brand is TYPE-LEVEL only: this file asserts both halves of that
// bargain. The runtime half runs under vitest -- a branded schema parses and
// serializes exactly as the plain one did, so the wire format cannot have
// moved. The compile-time half runs under `npm run typecheck`, which is where
// `@ts-expect-error` bites: each one below marks a transposition that USED to
// compile, and if a refactor ever un-brands a schema, tsc fails the build
// with "unused @ts-expect-error" -- the prove-it-can-fail rule, standing
// guard in both directions.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  accountKeySchema,
  blockEventCursorSchema,
  keysetCursorSchema,
  providerSlugSchema,
  ss58Schema,
  surfaceIdSchema,
  type BlockEventCursor,
  type Coldkey,
  type Hotkey,
  type KeysetCursor,
  type ProviderSlug,
  type Ss58Address,
  type SurfaceId,
} from "../schemas-src/query-params.ts";

const ADDRESS = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

describe("branded identifiers", () => {
  test("the brand does not move the wire format", () => {
    // Same input, same output, same rejection -- the brand is invisible at
    // runtime, which is the half of the contract the emitted JSON Schema
    // relies on.
    assert.equal(ss58Schema().parse(ADDRESS), ADDRESS);
    assert.equal(accountKeySchema("hotkey").parse(ADDRESS), ADDRESS);
    assert.equal(providerSlugSchema().parse("opentensor"), "opentensor");
    assert.equal(ss58Schema().safeParse("not-an-address").success, false);
  });

  test("a role key is still the generic address; the transpositions are not", () => {
    const hotkey: Hotkey = accountKeySchema("hotkey").parse(ADDRESS);
    const coldkey: Coldkey = accountKeySchema("coldkey").parse(ADDRESS);
    const slug: ProviderSlug = providerSlugSchema().parse("opentensor");

    // A hotkey IS an SS58 address -- the widening direction stays open, so a
    // function taking the generic address accepts either role.
    const asAddress: Ss58Address = hotkey;
    const coldAsAddress: Ss58Address = coldkey;
    assert.equal(asAddress, ADDRESS);
    assert.equal(coldAsAddress, ADDRESS);

    // @ts-expect-error a COLDKEY is not a hotkey -- the transposition #10866 exists to stop
    const wrongRole: Hotkey = coldkey;
    // @ts-expect-error a hotkey is not a coldkey -- same transposition, other direction
    const wrongRoleBack: Coldkey = hotkey;
    // @ts-expect-error an address with no proved role is not a hotkey
    const unproved: Hotkey = ss58Schema().parse(ADDRESS);
    // @ts-expect-error a provider slug is not an address
    const slugAsAddress: Ss58Address = slug;
    // @ts-expect-error a bare string proved nothing
    const bare: Ss58Address = ADDRESS;
    // The runtime VALUES are all still plain strings -- only the compiler
    // distinguishes them, which is the entire point.
    assert.deepEqual(
      [wrongRole, wrongRoleBack, unproved, slugAsAddress, bare],
      [ADDRESS, ADDRESS, ADDRESS, "opentensor", ADDRESS],
    );
  });
  test("the id and cursor families refuse each other too (#10866 sweep)", () => {
    const surface: SurfaceId = surfaceIdSchema().parse(
      "sn-64-chutes-subnet-api",
    );
    const keyset: KeysetCursor =
      keysetCursorSchema().parse("eyJiIjo4NzgzMDAwfQ");
    const dotted: BlockEventCursor =
      blockEventCursorSchema().parse("8783000.4");

    // @ts-expect-error a surface id is not a provider slug
    const idAsSlug: ProviderSlug = surface;
    // @ts-expect-error one feed's cursor is not the other's -- both are strings
    const wrongCursor: KeysetCursor = dotted;
    // @ts-expect-error and the other direction
    const wrongCursorBack: BlockEventCursor = keyset;
    assert.deepEqual(
      [idAsSlug, wrongCursor, wrongCursorBack],
      ["sn-64-chutes-subnet-api", "8783000.4", "eyJiIjo4NzgzMDAwfQ"],
    );
  });
});
