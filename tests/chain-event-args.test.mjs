import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeChainEventArgs } from "../src/chain-event-args.ts";

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

  test("hex-encodes an untagged positional 32-byte value with no field name when the event kind isn't in POSITIONAL_FIELD_NAMES (no ctx)", () => {
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

  test("decodes a positional SubtensorModule.TimelockedWeightsRevealed [netuid, who] to SS58, not hex (real block 8587756/2, fixed 2026-07-14 #5359/#61)", () => {
    // This is the SAME real args this file's hex-encoding test above uses --
    // proving the difference is entirely `ctx` (the fallback path with no
    // pallet/method still correctly can't know the field order and stays
    // hex), not a change to the underlying byte decode.
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
    assert.deepEqual(
      decodeChainEventArgs(args, {
        pallet: "SubtensorModule",
        method: "TimelockedWeightsRevealed",
      }),
      [78, "5Fk765B4CRBekwErwE5VxvveWhHztHSfsnsLt8cbDayDWsuk"],
    );
  });

  test("decodes a positional SubtensorModule.AxonServed [netuid, hotkey] to SS58 (real block 8619226 sample, #5359/#61)", () => {
    const args = [
      33,
      [
        [
          114, 211, 59, 166, 53, 72, 237, 250, 73, 154, 31, 222, 240, 135, 36,
          38, 38, 139, 52, 84, 62, 8, 208, 191, 72, 13, 65, 123, 86, 171, 97,
          71,
        ],
      ],
    ];
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "AxonServed",
    });
    assert.equal(decoded[0], 33);
    assert.ok(typeof decoded[1] === "string" && decoded[1].startsWith("5"));
  });

  test("decodes a positional SubtensorModule.NeuronRegistered [netuid, uid, hotkey] to SS58 (real block 8619226 sample, #5359/#61)", () => {
    const args = [
      3,
      30,
      [
        [
          118, 218, 242, 148, 66, 182, 145, 154, 35, 242, 77, 15, 119, 5, 163,
          99, 37, 63, 189, 121, 188, 87, 154, 78, 203, 176, 176, 248, 139, 90,
          208, 76,
        ],
      ],
    ];
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "NeuronRegistered",
    });
    assert.deepEqual(decoded.slice(0, 2), [3, 30]);
    assert.ok(typeof decoded[2] === "string" && decoded[2].startsWith("5"));
  });

  test("decodes a positional SubtensorModule.StakeTransferred [origin_coldkey, destination_coldkey, hotkey, origin_netuid, destination_netuid, amount] to SS58 across all three account positions (real block 8619226 sample, #5359/#61)", () => {
    const coldkeyA = new Array(32).fill(11);
    const coldkeyB = new Array(32).fill(22);
    const hotkey = new Array(32).fill(33);
    const args = [[coldkeyA], [coldkeyB], [hotkey], 0, 1, 1000000000];
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "StakeTransferred",
    });
    assert.ok(decoded[0].startsWith("5"));
    assert.ok(decoded[1].startsWith("5"));
    assert.ok(decoded[2].startsWith("5"));
    assert.notEqual(decoded[0], decoded[1]);
    assert.notEqual(decoded[0], decoded[2]);
    assert.deepEqual(decoded.slice(3), [0, 1, 1000000000]);
  });

  test("decodes a positional SubtensorModule.StakeMoved 6-field tuple, naming the 4th field destination_hotkey (real block 8619226 shape, #5359/#61)", () => {
    const coldkey = new Array(32).fill(44);
    const hotkey = new Array(32).fill(55);
    const destinationHotkey = new Array(32).fill(66);
    const args = [[coldkey], [hotkey], 84, [destinationHotkey], 84, 3094221033];
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "StakeMoved",
    });
    assert.ok(decoded[0].startsWith("5"));
    assert.ok(decoded[1].startsWith("5"));
    assert.ok(decoded[3].startsWith("5"));
    assert.notEqual(decoded[1], decoded[3]);
    assert.deepEqual(
      [decoded[2], decoded[4], decoded[5]],
      [84, 84, 3094221033],
    );
  });

  test("leaves a position past the known field names untouched (StakeAdded's confirmed-live but uncurated 6th field)", () => {
    const coldkey = new Array(32).fill(1);
    const hotkey = new Array(32).fill(2);
    const args = [[coldkey], [hotkey], 7990000000, 7990000000, 0, 0];
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "StakeAdded",
    });
    assert.ok(decoded[0].startsWith("5"));
    assert.ok(decoded[1].startsWith("5"));
    assert.deepEqual(decoded.slice(2), [7990000000, 7990000000, 0, 0]);
  });

  test("leaves a positional event kind with no fields containing an account (WeightsSet) as plain scalars", () => {
    assert.deepEqual(
      decodeChainEventArgs([62, 188], {
        pallet: "SubtensorModule",
        method: "WeightsSet",
      }),
      [62, 188],
    );
  });

  test("does not apply positional field names to an event kind not in the map", () => {
    const bytes = new Array(32).fill(5);
    assert.deepEqual(
      decodeChainEventArgs([1, [bytes]], {
        pallet: "SubtensorModule",
        method: "SomeUnmappedEvent",
      }),
      [1, "0x" + "05".repeat(32)],
    );
  });

  test("tolerates a ctx object missing pallet/method when checking POSITIONAL_FIELD_NAMES for array args", () => {
    // ctx is truthy (so the array/POSITIONAL_FIELD_NAMES branch runs) but
    // pallet/method are both absent -- the `?? ""` fallbacks must produce
    // "." rather than throwing, and that key correctly isn't in the map, so
    // this falls through to the same hex result as no ctx at all.
    const bytes = new Array(32).fill(5);
    assert.deepEqual(decodeChainEventArgs([1, [bytes]], {}), [
      1,
      "0x" + "05".repeat(32),
    ]);
  });

  test("decodes new_coldkey/old_coldkey to SS58 (real SubtensorModule.ColdkeySwapped, previously missing from ACCOUNT_KEYS despite arriving as a named object, #5359/#61)", () => {
    const newColdkey = new Array(32).fill(6);
    const oldColdkey = new Array(32).fill(7);
    const args = { new_coldkey: [newColdkey], old_coldkey: [oldColdkey] };
    const decoded = decodeChainEventArgs(args, {
      pallet: "SubtensorModule",
      method: "ColdkeySwapped",
    });
    assert.ok(decoded.new_coldkey.startsWith("5"));
    assert.ok(decoded.old_coldkey.startsWith("5"));
    assert.notEqual(decoded.new_coldkey, decoded.old_coldkey);
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
    // `"0x...hash"` when generic scalar-newtype normalization ran after
    // account/hash decoding. The chain-event normalizer now avoids that
    // ambiguous scalar-array collapse entirely because args have no type
    // descriptor to distinguish a wrapper from a one-element collection.
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

  test("decodes the expanded ACCOUNT_KEYS entries to SS58 (real Proxy.RealPaysFeeSet, block 8602853/169)", () => {
    const args = {
      real: [
        [
          110, 166, 14, 55, 47, 227, 14, 161, 235, 124, 205, 108, 34, 72, 103,
          213, 183, 86, 243, 33, 182, 132, 58, 138, 179, 161, 214, 5, 245, 217,
          13, 56,
        ],
      ],
      delegate: [
        [
          230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
          251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
          143, 88,
        ],
      ],
      pays_fee: true,
    };
    assert.deepEqual(decodeChainEventArgs(args), {
      real: "5EZnTF4puVufyK8HQvtw41gVrxe1GsfDMBtLSeNw5jQXocrp",
      delegate: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
      pays_fee: true,
    });
  });

  test("decodes new_hotkey/old_hotkey to SS58 alongside coldkey (real SubtensorModule.HotkeySwappedOnSubnet, block 8604030/450)", () => {
    const args = {
      netuid: 15,
      coldkey: [
        [
          144, 158, 68, 79, 84, 143, 61, 208, 20, 43, 118, 26, 39, 96, 148, 122,
          168, 30, 111, 246, 84, 111, 21, 202, 65, 235, 176, 84, 214, 32, 171,
          91,
        ],
      ],
      new_hotkey: [
        [
          228, 83, 193, 133, 106, 220, 127, 200, 235, 67, 95, 159, 89, 171, 150,
          18, 90, 19, 131, 225, 161, 7, 15, 132, 128, 133, 147, 204, 144, 163,
          135, 27,
        ],
      ],
      old_hotkey: [
        [
          130, 205, 192, 119, 145, 18, 5, 151, 137, 1, 185, 235, 182, 204, 47,
          122, 81, 6, 91, 207, 22, 229, 133, 239, 30, 171, 204, 195, 118, 169,
          31, 6,
        ],
      ],
    };
    const decoded = decodeChainEventArgs(args);
    assert.equal(
      decoded.new_hotkey,
      "5HE5eye8JdfMFe8Q1z7HosfwebqFUNUnyvmLZ1WWYtircSWe",
    );
    assert.equal(
      decoded.old_hotkey,
      "5F2DCjvQ5VruGJF2cjHfYou7SW6mVKBgpLjHFr6bF1SgAQWr",
    );
    assert.equal(decoded.netuid, 15);
  });

  test("hex-encodes an arbitrary-length EVM.Log.data byte blob regardless of length (real, block 8604282/307, 96 bytes)", () => {
    const args = {
      log: {
        data: new Array(96).fill(0).map((_, i) => (i * 7) % 256),
        address: [new Array(20).fill(1)],
        topics: [],
      },
    };
    const decoded = decodeChainEventArgs(args, {
      pallet: "EVM",
      method: "Log",
    });
    assert.equal(typeof decoded.log.data, "string");
    assert.match(decoded.log.data, /^0x[0-9a-f]{192}$/);
  });

  test("hex-encodes Contracts.ContractEmitted.data at a length that never coincidentally hits the 32-byte special case (real, block 8604169/872, 41 bytes)", () => {
    const args = {
      caller: [new Array(32).fill(2)],
      contract:
        "0xc94098c05c1e036d1901f16112166ceaf185f83c33eec1a2ee353caeb721ec43",
      data: [
        206, 2, 0, 0, 0, 0, 8, 80, 95, 223, 85, 98, 11, 0, 0, 0, 0, 0, 0, 0, 96,
        81, 155, 233, 204, 157, 239, 94, 11, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1,
      ],
    };
    const decoded = decodeChainEventArgs(args, {
      pallet: "Contracts",
      method: "ContractEmitted",
    });
    assert.equal(
      decoded.data,
      "0xce020000000008505fdf55620b0000000000000060519be9cc9def5e0b000000000000000200000001",
    );
  });

  test("leaves a byte blob raw when its pallet.method.field isn't in HEX_BLOB_FIELDS (no false-positive on shape alone)", () => {
    const args = { data: [1, 2, 3, 4, 5] };
    assert.deepEqual(
      decodeChainEventArgs(args, {
        pallet: "SomeOtherPallet",
        method: "SomeEvent",
      }),
      { data: [1, 2, 3, 4, 5] },
    );
  });

  test("unwraps MultiAddress::Signed(AccountId32) to an SS58 address, not raw hex (real Contracts.Called.caller, block 8605283/615, fixed 2026-07-12)", () => {
    // Found live 2026-07-12 during a 150-item ground-truth audit: caller
    // rendered as raw hex instead of SS58 despite the ENUM_PAYLOAD_FIELDS
    // "unwrap" entry existing for exactly this field -- decode() built the
    // enum wrapper's `out` object generically first (recursing into `values`
    // with keyHint="values", not the outer "caller"), so by the time
    // out.values[0] was unwrapped its account bytes had already been
    // hex-encoded under the wrong hint. Fixed by checking ENUM_PAYLOAD_FIELDS
    // against the RAW node before generic recursion, so the unwrap can
    // re-decode the payload under the OUTER field's own keyHint.
    const args = {
      caller: {
        name: "Signed",
        values: [
          [
            [
              12, 161, 152, 251, 73, 180, 215, 182, 98, 3, 243, 174, 222, 51,
              134, 229, 244, 110, 198, 95, 220, 89, 229, 182, 237, 96, 43, 252,
              89, 64, 167, 112,
            ],
          ],
        ],
      },
      contract:
        "0xc94098c05c1e036d1901f16112166ceaf185f83c33eec1a2ee353caeb721ec43",
    };
    const decoded = decodeChainEventArgs(args, {
      pallet: "Contracts",
      method: "Called",
    });
    assert.equal(
      decoded.caller,
      "5CMGSFvP5A2UAunRzjaZHx5BDBYmYBm8nQNdW25uZNqX5sEi",
    );
  });

  test("decodes multisig/approving to SS58 (real Multisig.MultisigApproval, block 4632809/18, fixed 2026-07-12)", () => {
    // Found live 2026-07-12: both fields rendered as raw hex -- missing from
    // ACCOUNT_KEYS entirely (call_hash correctly staying hex, since it's a
    // hash, not an account).
    const args = {
      multisig: [
        [
          186, 213, 47, 1, 241, 147, 62, 158, 248, 121, 160, 10, 7, 238, 71, 27,
          165, 167, 203, 221, 13, 96, 69, 222, 78, 252, 141, 157, 111, 214, 82,
          36,
        ],
      ],
      approving: [
        [
          208, 169, 201, 121, 190, 117, 20, 237, 200, 43, 143, 65, 208, 150, 33,
          47, 141, 90, 42, 172, 206, 45, 223, 232, 122, 127, 142, 209, 217, 224,
          110, 85,
        ],
      ],
      call_hash: [
        6, 171, 78, 162, 128, 230, 11, 75, 28, 70, 147, 177, 247, 165, 165, 113,
        145, 156, 233, 147, 172, 84, 72, 55, 227, 80, 81, 46, 4, 157, 139, 63,
      ],
      timepoint: { index: 7, height: 4632808 },
    };
    assert.deepEqual(
      decodeChainEventArgs(args, {
        pallet: "Multisig",
        method: "MultisigApproval",
      }),
      {
        multisig: "5GHg6KMXajvZPAbLEK2eKDrWz8r15d7ymShTW8hMfZLiPHgs",
        approving: "5GnJFiFL1X6nGUHQ2Sd3eVNRYeYwbkBDNRYdvgSeEJB5g6xV",
        call_hash:
          "0x06ab4ea280e60b4b1c4693b1f7a5a571919ce993ac544837e350512e049d8b3f",
        timepoint: { index: 7, height: 4632808 },
      },
    );
  });

  test("decodes sender to SS58, hash stays hex (real System.Remarked, block 8605284/559, fixed 2026-07-12)", () => {
    // Found live 2026-07-12: sender rendered as raw hex -- missing from
    // ACCOUNT_KEYS (hash correctly stayed hex, it's a hash, not an account).
    const args = {
      hash: [
        [
          191, 202, 247, 136, 103, 241, 66, 244, 111, 216, 15, 11, 170, 32, 109,
          126, 227, 240, 204, 114, 93, 72, 26, 39, 98, 154, 215, 132, 194, 90,
          117, 155,
        ],
      ],
      sender: [
        [
          196, 86, 57, 143, 56, 117, 132, 48, 77, 60, 250, 101, 214, 119, 121,
          140, 120, 53, 162, 127, 186, 101, 145, 121, 101, 95, 105, 169, 164, 6,
          148, 48,
        ],
      ],
    };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "System", method: "Remarked" }),
      {
        hash: "0xbfcaf78867f142f46fd80f0baa206d7ee3f0cc725d481a27629ad784c25a759b",
        sender: "5GW8reAHZEeVReXHq6QaDTQA82seeTME5BPKMEvRckmk4fgQ",
      },
    );
  });

  test('collapses Result<(),DispatchError>::Ok(()) to bare "Ok" (real Proxy.ProxyExecuted.result, block 8604336/424)', () => {
    const args = { result: { name: "Ok", values: [[]] } };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Proxy", method: "ProxyExecuted" }),
      { result: "Ok" },
    );
  });

  test("collapses Sudo.Sudid.sudo_result's Ok(()) the same way (real, block 231589/3)", () => {
    const args = { sudo_result: { name: "Ok", values: [[]] } };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Sudo", method: "Sudid" }),
      { sudo_result: "Ok" },
    );
  });

  test("preserves an Err(DispatchError) payload untouched -- only an empty-unit Ok(()) collapses", () => {
    const args = {
      result: {
        name: "Err",
        values: [
          { name: "Module", values: [{ index: 7, error: [31, 0, 0, 0] }] },
        ],
      },
    };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Proxy", method: "ProxyExecuted" }),
      {
        result: {
          name: "Err",
          values: [
            { name: "Module", values: [{ index: 7, error: [31, 0, 0, 0] }] },
          ],
        },
      },
    );
  });

  test("does not collapse an enum-tag node for a field outside ENUM_PAYLOAD_FIELDS", () => {
    const args = { outcome: { name: "Ok", values: [[]] } };
    assert.deepEqual(
      decodeChainEventArgs(args, {
        pallet: "SomeOtherPallet",
        method: "SomeEvent",
      }),
      { outcome: { name: "Ok", values: [[]] } },
    );
  });

  test("tolerates a ctx object missing pallet/method when checking the enum-payload allowlist", () => {
    const args = { result: { name: "Ok", values: [[]] } };
    assert.deepEqual(decodeChainEventArgs(args, {}), {
      result: { name: "Ok", values: [[]] },
    });
  });

  test("decodes contract (Contracts.ContractEmitted) to SS58, previously missing from ACCOUNT_KEYS (real block 8606116/157)", () => {
    const args = {
      contract: [
        [
          201, 64, 152, 192, 92, 30, 3, 109, 25, 1, 241, 97, 18, 22, 108, 234,
          241, 133, 248, 60, 51, 238, 193, 162, 238, 53, 60, 174, 183, 33, 236,
          67,
        ],
      ],
      data: [],
    };
    assert.equal(
      decodeChainEventArgs(args, {
        pallet: "Contracts",
        method: "ContractEmitted",
      }).contract,
      "5GcaftCj1psi5489Dp8RiL5UmMsbRMf9XsfNrDMMsfM5hFoB",
    );
  });

  test("decodes contract (Contracts.Called) to SS58 alongside caller, previously missing from ACCOUNT_KEYS (real block 8606268/612)", () => {
    const args = {
      caller: {
        name: "Signed",
        values: [
          [
            [
              202, 232, 71, 249, 210, 189, 168, 73, 116, 18, 3, 108, 59, 153,
              137, 124, 86, 117, 67, 86, 45, 7, 44, 82, 58, 94, 4, 234, 83, 139,
              27, 119,
            ],
          ],
        ],
      },
      contract: [
        [
          201, 64, 152, 192, 92, 30, 3, 109, 25, 1, 241, 97, 18, 22, 108, 234,
          241, 133, 248, 60, 51, 238, 193, 162, 238, 53, 60, 174, 183, 33, 236,
          67,
        ],
      ],
    };
    const out = decodeChainEventArgs(args, {
      pallet: "Contracts",
      method: "Called",
    });
    assert.equal(
      out.contract,
      "5GcaftCj1psi5489Dp8RiL5UmMsbRMf9XsfNrDMMsfM5hFoB",
    );
    assert.equal(
      out.caller,
      "5GekXoBfig3G9yqnYmD2N7VGruNQwqU2UpeksXDytzHEGduw",
    );
  });

  test("decodes signer (LimitOrders.OrderExecuted) to SS58, previously missing from ACCOUNT_KEYS (real block 8605497/410)", () => {
    const args = {
      netuid: 97,
      signer: [
        [
          234, 255, 34, 21, 96, 42, 74, 67, 71, 170, 124, 177, 152, 223, 123,
          243, 9, 253, 62, 44, 230, 106, 211, 253, 170, 40, 153, 130, 79, 78,
          235, 74,
        ],
      ],
      amount_in: 65802619318,
    };
    const out = decodeChainEventArgs(args, {
      pallet: "LimitOrders",
      method: "OrderExecuted",
    });
    assert.equal(
      out.signer,
      "5HNprQFF4MmHNgDFnfQE4XznnNaVTz2qBtufLG4Apq1RUNrf",
    );
    assert.equal(out.amount_in, 65802619318);
  });

  test("Drand.NewPulse's rounds stays an array for a single-round pulse, not collapsed to a bare number (real block 8606141/148)", () => {
    const args = { rounds: [30355357] };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Drand", method: "NewPulse" }),
      { rounds: [30355357] },
    );
  });

  test("Drand.NewPulse's rounds stays an array for a multi-round pulse (real block 4633999/58, unaffected baseline)", () => {
    const args = {
      rounds: [
        14409684, 14409685, 14409686, 14409687, 14409688, 14409689, 14409690,
        14409691,
      ],
    };
    assert.deepEqual(
      decodeChainEventArgs(args, { pallet: "Drand", method: "NewPulse" }),
      {
        rounds: [
          14409684, 14409685, 14409686, 14409687, 14409688, 14409689, 14409690,
          14409691,
        ],
      },
    );
  });

  test("preserves untyped single-element scalar arrays because chain_events args lack type context", () => {
    assert.deepEqual(decodeChainEventArgs([78]), [78]);
    assert.deepEqual(decodeChainEventArgs({ uids: [1] }), { uids: [1] });
    assert.deepEqual(decodeChainEventArgs({ outer: [[1], [2, 3]] }), {
      outer: [[1], [2, 3]],
    });
  });
});
