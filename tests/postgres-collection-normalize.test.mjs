import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeBTreeSetFields } from "../src/postgres-collection-normalize.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.ts";

// Chains after normalizePostgresValue, matching src/extrinsics.ts's actual
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

  test("is a no-op on an already-correctly-shaped typed-descriptor array (the real top-level call_args shape, confirmed live 2026-07-12)", () => {
    const descriptorShape = [
      { name: "subnets", type: "BTreeSet<NetUid>", value: [104, 71] },
    ];
    assert.deepEqual(
      decodeBTreeSetFields("SubtensorModule", "claim_root", descriptorShape),
      descriptorShape,
    );
  });

  test("unwraps a still-double-wrapped typed-descriptor value (real top-level call_args shape, block 8604385/23)", () => {
    // Unlike normalizePostgresValue's OWN typed-descriptor handling (which
    // already strips this layer when it can see the sibling `type` string),
    // this proves decodeBTreeSetFields' independent unwrap also does the
    // right thing if it ever received the raw, still-wrapped shape directly
    // (e.g. if called without normalizePostgresValue having run first).
    const descriptorShape = [
      { name: "subnets", type: "BTreeSet<u16>", value: [[84]] },
    ];
    const out = decodeBTreeSetFields(
      "SubtensorModule",
      "claim_root",
      descriptorShape,
    );
    assert.deepEqual(out[0].value, [84]);
  });

  test("unwraps a BTreeSet field nested inside a Utility.batch-wrapped call (real production fixture, block 8604111/11)", () => {
    // The raw shape indexer-rs actually serves for a nested claim_root call
    // -- confirmed live via direct Postgres query -- is the pallet/function
    // enum-tree BEFORE reconstruction: {name:"SubtensorModule",
    // values:[{name:"claim_root", values:{subnets:[[1,2,3,4,5]]}}]}, one
    // level down from Utility.batch's own `calls` typed descriptor. This
    // test starts from the shape AFTER decodePostgresCallArgs has already
    // reconstructed that into {call_module,call_function,call_args} --
    // src/postgres-call-args.test.mjs and tests/extrinsics.test.mjs cover
    // the reconstruction step (and its own BTREESET_FIELDS exclusion fix)
    // itself; this test is scoped to decodeBTreeSetFields' own recursive
    // unwrap.
    const reconstructed = [
      {
        name: "calls",
        type: "Vec<RuntimeCall>",
        value: [
          {
            call_module: "SubtensorModule",
            call_function: "claim_root",
            call_args: { subnets: [[1, 2, 3, 4, 5]] },
          },
        ],
      },
    ];
    const out = decode("Utility", "batch", reconstructed);
    assert.deepEqual(out[0].value[0].call_args.subnets, [1, 2, 3, 4, 5]);
  });

  test("leaves a non-allowlisted field inside a nested call untouched", () => {
    const reconstructed = [
      {
        call_module: "SubtensorModule",
        call_function: "add_stake",
        call_args: { amount: [[1, 2, 3]] },
      },
    ];
    const out = decode("Utility", "batch", reconstructed);
    assert.deepEqual(out[0].call_args.amount, [[1, 2, 3]]);
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

  test("unwraps LimitOrders.execute_batched_orders's orders (BoundedVec<SignedOrder,_>, real block 8617315/18, found by 2026-07-14/15 exhaustive audit)", () => {
    const descriptorShape = [
      { name: "netuid", type: "u16", value: 74 },
      {
        name: "orders",
        type: "BoundedVec<SignedOrder<AccountId32>, _>",
        value: [
          [{ order: { name: "V1", values: [{ amount: 462651842697 }] } }],
        ],
      },
    ];
    const out = decode(
      "LimitOrders",
      "execute_batched_orders",
      descriptorShape,
    );
    assert.deepEqual(out[1].value, [
      { order: { name: "V1", values: [{ amount: 462651842697 }] } },
    ]);
  });

  test("unwraps Commitments.set_commitment's info.fields (BoundedVec<Data,_> nested inside a struct field, real block 8623300/12, found by 2026-07-14/15 exhaustive audit)", () => {
    const descriptorShape = [
      { name: "netuid", type: "u16", value: 123 },
      {
        name: "info",
        type: "CommitmentInfo<_>",
        value: { fields: [[{ Raw100: "https://example.com" }]] },
      },
    ];
    const out = decode("Commitments", "set_commitment", descriptorShape);
    assert.deepEqual(out[1].value.fields, [{ Raw100: "https://example.com" }]);
  });
});
