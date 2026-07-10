import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeBTreeSetFields } from "../src/postgres-collection-normalize.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.mjs";

// Chains after normalizePostgresValue, matching src/extrinsics.mjs's actual
// formatExtrinsic call order.
function decode(callModule, callFunction, raw) {
  return decodeBTreeSetFields(
    callModule,
    callFunction,
    normalizePostgresValue(raw),
  );
}

describe("decodeBTreeSetFields", () => {
  test("unwraps a single-element BTreeSet (real SubtensorModule.claim_root, block 8587445/19)", () => {
    const out = decode("SubtensorModule", "claim_root", {
      subnets: [[104]],
    });
    assert.deepEqual(out.subnets, [104]);
  });

  test("unwraps a multi-element BTreeSet (synthetic -- no confirmed real multi-subnet claim_root occurrence, but the shape structurally supports it)", () => {
    const out = decode("SubtensorModule", "claim_root", {
      subnets: [[104, 71, 9]],
    });
    assert.deepEqual(out.subnets, [104, 71, 9]);
  });

  test("unwraps an empty BTreeSet", () => {
    const out = decode("SubtensorModule", "claim_root", { subnets: [[]] });
    assert.deepEqual(out.subnets, []);
  });

  test("is a no-op for a different call type's same-named field -- scoped to (callModule, callFunction, fieldName), not fieldName alone", () => {
    // A multi-element inner array here, deliberately -- normalizePostgresValue
    // (#4690) coincidentally partially collapses a SINGLE-element
    // [[x]] -> [x] on its own (an unrelated, pre-existing behavior of its
    // generic newtype-scalar rule, flagged separately), which would confound
    // this test's actual purpose: proving decodeBTreeSetFields's OWN
    // call-type scoping, not re-litigating that other pass's behavior.
    const out = decode("SomeOtherModule", "some_function", {
      subnets: [[104, 71]],
    });
    assert.deepEqual(out.subnets, [[104, 71]]);
  });

  test("is a no-op for a different field on the same call type", () => {
    const out = decode("SubtensorModule", "claim_root", {
      other_field: [[104, 71]],
    });
    assert.deepEqual(out.other_field, [[104, 71]]);
  });

  test("is a no-op on D1's own call_args shape (an array of {name,type,value} descriptors, not an object)", () => {
    const d1Shape = [
      { name: "subnets", type: "BTreeSet<NetUid>", value: [104, 71] },
    ];
    assert.deepEqual(
      decodeBTreeSetFields("SubtensorModule", "claim_root", d1Shape),
      d1Shape,
    );
  });

  test("is a no-op on null/undefined/scalar call_args", () => {
    assert.equal(
      decodeBTreeSetFields("SubtensorModule", "claim_root", null),
      null,
    );
    assert.equal(
      decodeBTreeSetFields("SubtensorModule", "claim_root", undefined),
      undefined,
    );
    assert.equal(decodeBTreeSetFields("SubtensorModule", "claim_root", 42), 42);
  });

  test("leaves sibling fields on the same call untouched", () => {
    const out = decode("SubtensorModule", "claim_root", {
      subnets: [[104]],
      netuid: 9,
    });
    assert.equal(out.netuid, 9);
  });
});
