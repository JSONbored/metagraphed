import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeChainEventArgs } from "../src/chain-event-args.mjs";

describe("decodeChainEventArgs", () => {
  test("decodes an account-keyed 32-byte field to SS58 (real TransactionFeePaid.who, block 8587754/412)", () => {
    const args = {
      tip: 0,
      who: [
        [
          230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
          251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
          143, 88,
        ],
      ],
      actual_fee: 2131419,
    };
    assert.deepEqual(decodeChainEventArgs(args), {
      tip: 0,
      who: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
      actual_fee: 2131419,
    });
  });

  test("decodes both to/from account-keyed fields (real Balances.Transfer, block 8587754/119)", () => {
    const args = {
      to: [
        [
          109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      ],
      from: [
        [
          109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 15, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      ],
      amount: 30681,
    };
    assert.deepEqual(decodeChainEventArgs(args), {
      to: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
      from: "5EYCAe5jLQhn6ofDSvuKE7htj4zVF4Tq1J7DTNzTePVJucfX",
      amount: 30681,
    });
  });

  test("hex-encodes an untagged positional 32-byte value with no field name (real SubtensorModule.TimelockedWeightsRevealed, block 8587756/2)", () => {
    const args = [
      78,
      [
        [
          162, 193, 121, 87, 196, 67, 129, 183, 243, 158, 111, 10, 171, 37, 31,
          122, 9, 152, 89, 131, 234, 97, 249, 41, 16, 168, 179, 154, 146, 252,
          209, 69,
        ],
      ],
    ];
    assert.deepEqual(decodeChainEventArgs(args), [
      78,
      "0xa2c17957c44381b7f39e6f0aab251f7a09985983ea61f92910a8b39a92fcd145",
    ]);
  });

  test("preserves array-ness for a hypothetical Vec<AccountId>-shaped field (each entry independently newtype-wrapped, not collapsed like a scalar field)", () => {
    // No currently-observed chain_events field has this shape (a real
    // Vec<AccountId> -- e.g. Multisig.other_signatories, verified this
    // session as [[[b..]], [[b..]]], each entry its own [[bytes]] newtype
    // wrap -- lives in extrinsics.call_args, not chain_events.args). This is
    // a defensive structural test, keyed on an actual ACCOUNT_KEYS entry
    // ("who"), proving the collapse only fires one array layer at a time so
    // a genuine multi-entry array isn't flattened into a single value the
    // way a bare scalar field correctly is.
    const sig1 = new Array(32).fill(1);
    const sig2 = new Array(32).fill(2);
    const args = { who: [[sig1], [sig2]] };
    const decoded = decodeChainEventArgs(args);
    assert.ok(Array.isArray(decoded.who));
    assert.equal(decoded.who.length, 2);
    assert.ok(
      decoded.who.every((s) => typeof s === "string" && s.startsWith("5")),
    );
    assert.notEqual(decoded.who[0], decoded.who[1]);
  });

  test("hex-encodes a 32-byte field whose name isn't in the account allowlist (e.g. a hash)", () => {
    const bytes = new Array(32).fill(7);
    assert.deepEqual(decodeChainEventArgs({ call_hash: [bytes] }), {
      call_hash: "0x" + "07".repeat(32),
    });
  });

  test("is idempotent on already-decoded data (safe no-op if run twice)", () => {
    const decoded = decodeChainEventArgs({
      who: [new Array(32).fill(1)],
    });
    assert.deepEqual(decodeChainEventArgs(decoded), decoded);
  });

  test("leaves non-byte-array values (scalars, short arrays, nested structs) untouched", () => {
    const args = { netuid: 5, weights: [1, 2, 3], nested: { a: "b" } };
    assert.deepEqual(decodeChainEventArgs(args), args);
  });

  test("passes through null/undefined/non-object args without throwing", () => {
    assert.equal(decodeChainEventArgs(null), null);
    assert.equal(decodeChainEventArgs(undefined), undefined);
    assert.equal(decodeChainEventArgs(42), 42);
    assert.equal(decodeChainEventArgs("x"), "x");
  });

  test("unwraps a C-like unit-variant enum tag to its bare name (real System.ExtrinsicSuccess.dispatch_info, block 8602601/381, fixed 2026-07-12)", () => {
    // Found live 2026-07-11: dispatch_info.class/pays_fee rendered as
    // {"name":"Normal","values":[]} / {"name":"No","values":[]} instead of
    // the bare strings D1 always produced -- decodeChainEventArgs only ran
    // the account-id decode above, never normalizePostgresValue's C-like
    // unit-enum rule (#4690), despite every other consumer of that rule
    // (extrinsics.call_args) already getting it.
    const args = {
      dispatch_info: {
        class: { name: "Normal", values: [] },
        weight: { ref_time: 1012718000, proof_size: 11869 },
        pays_fee: { name: "No", values: [] },
      },
    };
    assert.deepEqual(decodeChainEventArgs(args), {
      dispatch_info: {
        class: "Normal",
        weight: { ref_time: 1012718000, proof_size: 11869 },
        pays_fee: "No",
      },
    });
  });

  test("unwraps an Option<T> Some/None pair alongside an account-keyed field in the same event", () => {
    const bytes = new Array(32).fill(9);
    const args = {
      who: [bytes],
      maybe_amount: { name: "Some", values: [42] },
      maybe_note: { name: "None", values: [] },
    };
    assert.deepEqual(decodeChainEventArgs(args), {
      who: "5CGYyLcrWUfBDKExbvRjDQinEoCZWQmD6SjaXBLhny6A2wjE",
      maybe_amount: 42,
      maybe_note: null,
    });
  });
});
