import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { normalizePostgresValue } from "../src/scale-normalize.mjs";

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
