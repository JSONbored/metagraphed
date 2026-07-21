import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { normalizePostgresValue } from "../src/scale-normalize.ts";

describe("normalizePostgresValue", () => {
  describe("Option<T> (Some/None)", () => {
    test("unwraps Some to its inner value (real AdminUtils.sudo_set_mechanism_emission_split, block 8559935/32)", () => {
      assert.deepEqual(
        normalizePostgresValue({ name: "Some", values: [[0, 65535]] }),
        [0, 65535],
      );
    });

    test("unwraps None to null (real Multisig.approve_as_multi maybe_timepoint, block 8587346/18)", () => {
      assert.equal(normalizePostgresValue({ name: "None", values: [] }), null);
    });

    test("unwraps a scalar Some", () => {
      assert.equal(normalizePostgresValue({ name: "Some", values: [42] }), 42);
    });

    test("unwraps None for LimitOrders.execute_batched_orders' relayer/partial_fill (block 8587347/16)", () => {
      const args = {
        relayer: { name: "None", values: [] },
        partial_fill: { name: "None", values: [] },
      };
      assert.deepEqual(normalizePostgresValue(args), {
        relayer: null,
        partial_fill: null,
      });
    });
  });

  describe("C-like unit-variant enums", () => {
    test("flattens to the bare variant name (real Proxy.add_proxy proxy_type, block 8587138/24)", () => {
      assert.equal(normalizePostgresValue({ name: "Any", values: [] }), "Any");
    });

    test("flattens SubtensorModule.set_root_claim_type's new_root_claim_type (block 8586560/17)", () => {
      assert.equal(
        normalizePostgresValue({ name: "Swap", values: [] }),
        "Swap",
      );
    });

    test("flattens LimitOrders.execute_batched_orders' order_type (block 8587347/16)", () => {
      assert.equal(
        normalizePostgresValue({ name: "StopLoss", values: [] }),
        "StopLoss",
      );
    });
  });

  describe("generic newtype-scalar unwrap", () => {
    test("unwraps a 1-tuple wrapping a plain number (real LimitOrders.execute_batched_orders fee_rate, block 8587347/16) -- satisfies #4693's scalar-newtype-generalization requirement: this rule was never special-cased to byte-blob-shaped wrappers only", () => {
      assert.equal(normalizePostgresValue([0]), 0);
    });

    test("unwraps a 1-tuple wrapping a string", () => {
      assert.equal(normalizePostgresValue(["hello"]), "hello");
    });

    test("unwraps a 1-tuple wrapping a boolean or null", () => {
      assert.equal(normalizePostgresValue([true]), true);
      assert.equal(normalizePostgresValue([null]), null);
    });
  });

  describe("passthrough cases (NOT this module's job)", () => {
    test("leaves an Ethereum-style enum-with-data node untouched (recurses into contents only)", () => {
      const node = { name: "EIP1559", values: [{ nonce: 1 }] };
      assert.deepEqual(normalizePostgresValue(node), {
        name: "EIP1559",
        values: [{ nonce: 1 }],
      });
    });

    test("recurses into an enum-with-data node's own contents", () => {
      const node = {
        name: "Some",
        values: [{ name: "EIP1559", values: [{ a: [5] }] }],
      };
      // Some unwraps first; the inner EIP1559 node's own contents still get
      // the newtype-scalar rule applied (a: [5] -> a: 5), but its own
      // {name,values} shape is preserved.
      assert.deepEqual(normalizePostgresValue(node), {
        name: "EIP1559",
        values: [{ a: 5 }],
      });
    });

    test("leaves a 1-element array wrapping an array untouched (AccountId32/byte-blob territory, #4688/#4689)", () => {
      const bytes = [1, 2, 3];
      assert.deepEqual(normalizePostgresValue([bytes]), [bytes]);
    });

    test("leaves a 1-element array wrapping an object untouched", () => {
      const obj = { a: 1 };
      assert.deepEqual(normalizePostgresValue([obj]), [{ a: 1 }]);
    });

    test("leaves a nested RuntimeCall enum-tree shape as a generic enum-with-data node (#4691's concern, not normalized here)", () => {
      const node = {
        name: "Balances",
        values: [{ name: "transfer_all", values: {} }],
      };
      assert.deepEqual(normalizePostgresValue(node), node);
    });
  });

  describe("recursion", () => {
    test("normalizes Option/enum/newtype patterns nested inside an array element", () => {
      const arr = [
        { name: "Some", values: [1] },
        { name: "None", values: [] },
        [7],
      ];
      assert.deepEqual(normalizePostgresValue(arr), [1, null, 7]);
    });

    test("normalizes patterns nested inside a struct field", () => {
      const obj = {
        a: { name: "Some", values: [1] },
        b: { name: "Foo", values: [] },
      };
      assert.deepEqual(normalizePostgresValue(obj), { a: 1, b: "Foo" });
    });

    test("normalizes two levels deep (struct containing an array containing an Option)", () => {
      const obj = { list: [{ name: "Some", values: [{ x: [9] }] }] };
      assert.deepEqual(normalizePostgresValue(obj), { list: [{ x: 9 }] });
    });
  });

  describe("D1-shaped idempotence (requirement: must be a no-op on D1's own shape)", () => {
    test("leaves D1's {name,type,value} descriptor array untouched", () => {
      const d1CallArgs = [
        { name: "netuid", type: "NetUid", value: 9 },
        { name: "dests", type: "Vec<u16>", value: [21, 209] },
      ];
      assert.deepEqual(normalizePostgresValue(d1CallArgs), d1CallArgs);
    });

    test("leaves a single-descriptor D1 call_args array untouched (not mistaken for a newtype-scalar wrap)", () => {
      const d1CallArgs = [
        { name: "now", type: "Moment", value: 1783643784000 },
      ];
      assert.deepEqual(normalizePostgresValue(d1CallArgs), d1CallArgs);
    });

    test("leaves an already-flat D1 value (a plain array, e.g. dests: [21, 209]) untouched", () => {
      assert.deepEqual(normalizePostgresValue([21, 209]), [21, 209]);
    });
  });

  describe("#4724 regression: a collection-typed D1 descriptor must stay an array at ANY element count", () => {
    test("preserves a single-destination SubtensorModule.set_weights dests (real, block 8588865/15 -- was served as bare 0, confirmed live before this fix)", () => {
      const descriptor = { name: "dests", type: "Vec<u16>", value: [0] };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("preserves a single-weight SubtensorModule.set_weights weights (real, block 8588865/15 -- was served as bare 65535)", () => {
      const descriptor = { name: "weights", type: "Vec<u16>", value: [65535] };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("preserves single-element dests/weights inside a full call_args array (both fields collapse independently -- must both survive)", () => {
      const callArgs = [
        { name: "netuid", type: "NetUid", value: 3 },
        { name: "dests", type: "Vec<u16>", value: [11] },
        { name: "weights", type: "Vec<u16>", value: [65535] },
        { name: "version_key", type: "u64", value: 1 },
      ];
      assert.deepEqual(normalizePostgresValue(callArgs), callArgs);
    });

    test("preserves a single-subnet SubtensorModule.claim_root subnets (real, block 8588525/16 -- BTreeSet<NetUid>, was served as bare 104)", () => {
      const descriptor = {
        name: "subnets",
        type: "BTreeSet<NetUid>",
        value: [104],
      };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("preserves a single-signatory Multisig.approve_as_multi other_signatories (string-typed element, not numeric -- confirms the fix isn't scalar-type-specific)", () => {
      const descriptor = {
        name: "other_signatories",
        type: "Vec<AccountId>",
        value: ["5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"],
      };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("preserves a single-entry BoundedVec descriptor (generic collection prefix coverage beyond bare Vec/BTreeSet)", () => {
      const descriptor = {
        name: "orders",
        type: "BoundedVec<SignedOrder<AccountId>, MaxOrdersPerBatch>",
        value: [{ id: 1 }],
      };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("still collapses a genuine non-collection single-value descriptor (NOT a regression -- Moment/NetUid/etc never wrapped an array to begin with)", () => {
      const descriptor = { name: "netuid", type: "NetUid", value: 9 };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("falls through to generic normalize() for a collection-typed descriptor whose value isn't actually an array (defensive; not expected for a real row)", () => {
      const descriptor = {
        name: "subnets",
        type: "BTreeSet<NetUid>",
        value: null,
      };
      assert.deepEqual(normalizePostgresValue(descriptor), descriptor);
    });

    test("still recurses normally inside a preserved collection's elements (an element could itself be an Option/enum)", () => {
      const descriptor = {
        name: "maybe_list",
        type: "Vec<Option<u16>>",
        value: [{ name: "Some", values: [5] }],
      };
      assert.deepEqual(normalizePostgresValue(descriptor), {
        name: "maybe_list",
        type: "Vec<Option<u16>>",
        value: [5],
      });
    });
  });

  describe("edge cases", () => {
    test("passes through null/undefined/scalars without throwing", () => {
      assert.equal(normalizePostgresValue(null), null);
      assert.equal(normalizePostgresValue(undefined), undefined);
      assert.equal(normalizePostgresValue(42), 42);
      assert.equal(normalizePostgresValue("x"), "x");
      assert.equal(normalizePostgresValue(true), true);
    });

    test("passes through an empty array and empty object unchanged", () => {
      assert.deepEqual(normalizePostgresValue([]), []);
      assert.deepEqual(normalizePostgresValue({}), {});
    });

    test("does not mistake a plain object with name+values+extra keys for an enum-tree node", () => {
      const obj = { name: "Any", values: [], extra: 1 };
      assert.deepEqual(normalizePostgresValue(obj), {
        name: "Any",
        values: [],
        extra: 1,
      });
    });

    test("does not mistake an enum-tree-shaped node with a non-string name for one", () => {
      const obj = { name: 5, values: [] };
      assert.deepEqual(normalizePostgresValue(obj), { name: 5, values: [] });
    });
  });
});
