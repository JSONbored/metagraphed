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

  test("hex-encodes 20-byte H160 fields to/from (real Ethereum.Executed, block 8602940/418, fixed 2026-07-12)", () => {
    // Found live 2026-07-11 alongside the enum-tag bug above:
    // Ethereum.Executed's to/from rendered as raw 20-byte arrays instead of
    // hex H160 addresses -- decodeChainEventArgs's account/hash decode was
    // scoped to exactly 32 bytes (AccountId32), with no 20-byte (H160) case
    // at all.
    const args = {
      to: [
        [
          143, 106, 34, 194, 22, 130, 183, 168, 135, 112, 85, 219, 92, 193, 49,
          205, 140, 165, 81, 159,
        ],
      ],
      from: [
        [
          133, 92, 161, 0, 143, 62, 255, 142, 6, 54, 70, 251, 181, 205, 213,
          120, 9, 182, 19, 77,
        ],
      ],
      extra_data: [71, 111, 116, 116, 97, 32, 71, 111, 32, 70, 97, 115, 116],
      transaction_hash:
        "0x62ae62f39383da65709133bd09033de7dd97bdc761f3f4b9247aacb1a17beeec",
    };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Ethereum", method: "Executed" }),
      {
        to: "0x8f6a22c21682b7a8877055db5cc131cd8ca5519f",
        from: "0x855ca1008f3eff8e063646fbb5cdd57809b6134d",
        extra_data: "Gotta Go Fast",
        transaction_hash:
          "0x62ae62f39383da65709133bd09033de7dd97bdc761f3f4b9247aacb1a17beeec",
      },
    );
  });

  test("hex-encodes a nested 20-byte H160 field regardless of key depth (real EVM.Log.log.address, block 8602940/418)", () => {
    const args = {
      log: {
        data: "0x000000000000000000000000000000000000000000000000000000000000000c",
        address: [
          [
            218, 113, 193, 120, 106, 128, 89, 109, 32, 202, 31, 37, 41, 213, 16,
            64, 235, 145, 235, 28,
          ],
        ],
      },
    };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "EVM", method: "Log" }),
      {
        log: {
          data: "0x000000000000000000000000000000000000000000000000000000000000000c",
          address: "0xda71c1786a80596d20ca1f2529d51040eb91eb1c",
        },
      },
    );
  });

  test("keeps a single-element Vec<H256> as an array, not collapsed to a bare string (real EVM.Log.log.topics, fixed 2026-07-12)", () => {
    // Found live 2026-07-12 while fixing the H160 gap above: a single-topic
    // EVM.Log collapsed `topics` from `["0x...hash"]` down to a bare
    // `"0x...hash"` -- normalizePostgresValue's newtype-scalar rule fired
    // because, by the time it ran, the account/hash decode had already
    // turned the sole topic into a plain hex STRING (a scalar), making the
    // outer single-element array indistinguishable from a genuine
    // newtype-scalar wrap. Fixed by running normalizePostgresValue BEFORE
    // the byte-array decode instead of after (see decodeChainEventArgs'
    // own header for why this reordering is safe).
    const hash = new Array(32).fill(3);
    const args = { log: { topics: [[hash]] } };
    const decoded = decodeChainEventArgs(args, {
      pallet: "EVM",
      method: "Log",
    });
    assert.deepEqual(decoded.log.topics, ["0x" + "03".repeat(32)]);
  });

  test("is idempotent on already-decoded H160/textual data (safe no-op if run twice)", () => {
    const decoded = decodeChainEventArgs(
      {
        to: [new Array(20).fill(1)],
        extra_data: [72, 105], // "Hi"
      },
      { pallet: "Ethereum", method: "Executed" },
    );
    assert.deepEqual(
      decodeChainEventArgs(decoded, { pallet: "Ethereum", method: "Executed" }),
      decoded,
    );
  });

  test("leaves a variable-length byte field as a raw array when its pallet.method.field isn't in the textual allowlist", () => {
    const args = { extra_data: [1, 2, 3] };
    assert.deepEqual(
      decodeChainEventArgs(args, {
        pallet: "SomeOtherPallet",
        method: "SomeEvent",
      }),
      { extra_data: [1, 2, 3] },
    );
  });

  test("falls back to hex for a textual-allowlisted field with malformed UTF-8 bytes", () => {
    // 0xff is never valid UTF-8 (not even as a continuation byte), so this
    // exercises decodeTextualField's catch fallback rather than producing
    // mojibake.
    const args = { extra_data: [0xff, 0xfe] };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Ethereum", method: "Executed" }),
      { extra_data: "0xfffe" },
    );
  });

  test("tolerates a ctx object missing pallet/method when checking the textual allowlist", () => {
    // ctx is truthy (so the allowlist check runs) but pallet/method are both
    // absent -- the key's `??` fallbacks must produce "..extra_data" rather
    // than throwing, and that key correctly isn't in TEXTUAL_FIELDS.
    const args = { extra_data: [1, 2, 3] };
    assert.deepEqual(decodeChainEventArgs(args, {}), { extra_data: [1, 2, 3] });
  });
});
