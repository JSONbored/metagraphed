import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodePostgresCallArgs } from "../src/postgres-call-args.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.mjs";

// decodePostgresCallArgs must run BEFORE normalizePostgresValue (see
// src/postgres-call-args.mjs's own header for why) -- every test below
// chains them in that order, matching src/extrinsics.mjs's formatExtrinsic.
function decode(value) {
  return normalizePostgresValue(decodePostgresCallArgs(value));
}

describe("decodePostgresCallArgs", () => {
  describe("real production fixtures", () => {
    test("Proxy.proxy wrapping SubtensorModule.commit_timelocked_mechanism_weights (block 8587453/22)", () => {
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [
            {
              name: "commit_timelocked_mechanism_weights",
              values: {
                mecid: 0,
                commit: [[147, 47, 10, 12, 1, 83]],
                netuid: 4,
                reveal_round: 30280658,
                commit_reveal_version: 4,
              },
            },
          ],
        },
        real: {
          name: "Id",
          values: [
            [
              [
                88, 174, 247, 177, 239, 180, 72, 6, 254, 20, 198, 197, 141, 12,
                30, 182, 52, 165, 159, 210, 81, 63, 12, 237, 111, 45, 16, 224,
                86, 154, 244, 13,
              ],
            ],
          ],
        },
        force_proxy_type: { name: "None", values: [] },
      };
      const out = decode(raw);
      assert.deepEqual(out.call, {
        call_module: "SubtensorModule",
        call_function: "commit_timelocked_mechanism_weights",
        call_args: {
          mecid: 0,
          commit: "0x932f0a0c0153",
          netuid: 4,
          reveal_round: 30280658,
          commit_reveal_version: 4,
        },
      });
    });

    test("byte-blob field within a reconstructed nested call decodes to hex, not raw array", () => {
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [
            {
              name: "commit_timelocked_mechanism_weights",
              values: { commit: [[1, 2, 255, 0]] },
            },
          ],
        },
      };
      assert.equal(decode(raw).call.call_args.commit, "0x0102ff00");
    });

    test("Proxy.proxy's own top-level fields (real, force_proxy_type) are BOTH decoded -- real via the ACCOUNT_KEYS name heuristic, fixed 2026-07-12 alongside the top-level AccountId32/MultiAddress typed-descriptor fix", () => {
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [{ name: "commit_timelocked_mechanism_weights", values: {} }],
        },
        real: {
          name: "Id",
          values: [
            [
              [
                88, 174, 247, 177, 239, 180, 72, 6, 254, 20, 198, 197, 141, 12,
                30, 182, 52, 165, 159, 210, 81, 63, 12, 237, 111, 45, 16, 224,
                86, 154, 244, 13,
              ],
            ],
          ],
        },
        force_proxy_type: { name: "None", values: [] },
      };
      const out = decode(raw);
      // force_proxy_type IS unwrapped -- that's normalizePostgresValue's
      // Option<T> rule (#4690), unaffected by #4691's narrower scope.
      assert.equal(out.force_proxy_type, null);
      // real: a MultiAddress::Id-wrapped AccountId32, previously left raw
      // because the ACCOUNT_KEYS name heuristic was gated behind an
      // enclosing reconstructed call -- a top-level field never had one.
      // Now decoded regardless of nesting (2026-07-12): the untyped
      // enum-tree shape carries no `type` string to consult, so this relies
      // on "real" being an unambiguous account-field name, same as any
      // other ACCOUNT_KEYS entry.
      assert.equal(
        out.real,
        "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
      );
    });

    test("Utility.batch wrapping 8 SubtensorModule.transfer_stake calls, each independently reconstructed and decoded (block 8587171/21)", () => {
      const hotkey = [
        120, 150, 23, 189, 146, 106, 33, 202, 103, 15, 93, 72, 101, 244, 73,
        248, 0, 42, 216, 188, 57, 209, 166, 43, 96, 120, 62, 61, 222, 107, 182,
        36,
      ];
      const coldkeyA = [
        102, 178, 9, 24, 55, 169, 128, 172, 45, 21, 139, 163, 206, 123, 174,
        196, 240, 241, 190, 212, 101, 206, 12, 128, 30, 12, 121, 70, 229, 225,
        181, 91,
      ];
      const coldkeyB = [
        104, 9, 157, 251, 75, 66, 250, 0, 149, 146, 134, 20, 68, 117, 27, 138,
        241, 231, 201, 190, 9, 253, 56, 248, 136, 133, 225, 84, 155, 76, 255,
        21,
      ];
      const rawCall = (alphaAmount, destinationColdkey) => ({
        name: "SubtensorModule",
        values: [
          {
            name: "transfer_stake",
            values: {
              hotkey: [hotkey],
              alpha_amount: alphaAmount,
              origin_netuid: 9,
              destination_netuid: 9,
              destination_coldkey: [destinationColdkey],
            },
          },
        ],
      });
      const raw = {
        calls: [rawCall(3358540310, coldkeyA), rawCall(15059873560, coldkeyB)],
      };
      const out = decode(raw);
      assert.equal(out.calls.length, 2);
      for (const call of out.calls) {
        assert.equal(call.call_module, "SubtensorModule");
        assert.equal(call.call_function, "transfer_stake");
        // Same hotkey across every batched call -- confirms the decode is
        // per-instance (not accidentally memoized/shared) and correct on a
        // repeated value.
        assert.equal(
          call.call_args.hotkey,
          "5EnpBz2DoMTzMztFSVPSpi8jP2yfGadU6kgZgsjqnfvonMgu",
        );
      }
      // destination_coldkey is a COMPOUND field name (not a bare "coldkey")
      // -- exercises the hotkey/coldkey suffix rule, not just the exact-match
      // ACCOUNT_KEYS set (confirmed missing this field name during
      // implementation -- chain_events.args field names are short/single-word,
      // call_args' are often compound).
      assert.equal(
        out.calls[0].call_args.destination_coldkey,
        "5EPMdSCoV3NWhLb7DVZKvC6tXbW3GivbAHrVnp348PZeRoo9",
      );
      assert.equal(
        out.calls[1].call_args.destination_coldkey,
        "5ER7hD36RAFgXRKjfRjTBcP7TVnmfs284hgpzngH2pUmo4MR",
      );
      assert.equal(out.calls[0].call_args.alpha_amount, 3358540310);
      assert.equal(out.calls[1].call_args.alpha_amount, 15059873560);
    });

    test("Multisig.as_multi -> Sudo.sudo -> Utility.batch_all -> AdminUtils, three reconstruction levels deep (block 8584692/19)", () => {
      const raw = {
        call: {
          name: "Sudo",
          values: [
            {
              name: "sudo",
              values: {
                call: {
                  name: "Utility",
                  values: [
                    {
                      name: "batch_all",
                      values: {
                        calls: [
                          {
                            name: "AdminUtils",
                            values: [
                              {
                                name: "sudo_set_subnet_emission_enabled",
                                values: { netuid: 78, enabled: true },
                              },
                            ],
                          },
                          {
                            name: "AdminUtils",
                            values: [
                              {
                                name: "sudo_set_subnet_emission_enabled",
                                values: { netuid: 121, enabled: true },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        threshold: 2,
        max_weight: { ref_time: 1089922230, proof_size: 47024 },
        maybe_timepoint: {
          name: "Some",
          values: [{ index: 24, height: 8579473 }],
        },
        other_signatories: [
          [
            [
              90, 138, 31, 119, 52, 147, 154, 124, 111, 20, 208, 31, 158, 15,
              55, 225, 19, 181, 156, 209, 18, 191, 149, 15, 163, 102, 71, 123,
              235, 91, 83, 11,
            ],
          ],
        ],
      };
      const out = decode(raw);
      assert.deepEqual(out.call, {
        call_module: "Sudo",
        call_function: "sudo",
        call_args: {
          call: {
            call_module: "Utility",
            call_function: "batch_all",
            call_args: {
              calls: [
                {
                  call_module: "AdminUtils",
                  call_function: "sudo_set_subnet_emission_enabled",
                  call_args: { netuid: 78, enabled: true },
                },
                {
                  call_module: "AdminUtils",
                  call_function: "sudo_set_subnet_emission_enabled",
                  call_args: { netuid: 121, enabled: true },
                },
              ],
            },
          },
        },
      });
      // Top-level Multisig fields untouched by #4691, normalized by #4690 as before.
      assert.equal(out.threshold, 2);
      assert.deepEqual(out.maybe_timepoint, { index: 24, height: 8579473 });
    });

    test("Multisig.as_multi's nested call_hash stays absent, not fabricated (block 8587390/13 -- the permanent accepted gap)", () => {
      const raw = {
        call: {
          name: "Balances",
          values: [
            {
              name: "transfer_keep_alive",
              values: {
                dest: {
                  name: "Id",
                  values: [
                    [
                      [
                        202, 181, 160, 24, 153, 159, 12, 80, 104, 152, 143, 220,
                        228, 103, 60, 102, 201, 95, 2, 218, 67, 10, 147, 67,
                        239, 62, 216, 148, 99, 63, 194, 63,
                      ],
                    ],
                  ],
                },
                value: 400000000000,
              },
            },
          ],
        },
        threshold: 2,
      };
      const out = decode(raw);
      assert.equal(out.call.call_module, "Balances");
      assert.equal(out.call.call_function, "transfer_keep_alive");
      assert.equal(
        out.call.call_args.dest,
        "5GeVV21s1W8aDuCg8zoNFQ5TnhPr643dXgEnigbUtGiZPeJY",
      );
      assert.equal(out.call.call_args.value, 400000000000);
      // No call_hash key anywhere on the reconstructed call -- indexer-rs's
      // dynamic-value dump has no equivalent of fetch-events.py's Python-side
      // re-encode-and-hash step. Absent, not null and not fabricated.
      assert.equal("call_hash" in out.call, false);
    });
  });

  describe("top-level typed-descriptor AccountId32/MultiAddress fields (fixed 2026-07-12)", () => {
    // Found live 2026-07-11 during a full data-pipeline audit: an extrinsic's
    // OWN top-level call_args (the {name,type,value} descriptor array
    // indexer-rs's #4724 typed JSON produces) never ran through ANY
    // AccountId32/MultiAddress decode -- only fields inside a reconstructed
    // NESTED call did (#4691's scope). Confirmed against real production
    // API responses before this fix: GET /api/v1/extrinsics?call_module=
    // SubtensorModule&call_function=add_stake served block 8602480/21's
    // `hotkey` field as a raw [[b0..b31]] array instead of an SS58 string,
    // and GET /api/v1/extrinsics/0xf4a09042...c86be (Balances.
    // transfer_keep_alive, block 8602605/18) served `dest`
    // (MultiAddress<AccountId32, ()>) the same way. This affected almost
    // every SubtensorModule/Balances extrinsic, since a top-level account
    // field is the common case, not the exception.
    test("SubtensorModule.add_stake's top-level hotkey (real, block 8602480/21)", () => {
      const out = decode([
        {
          name: "hotkey",
          type: "AccountId32",
          value: [
            [
              82, 234, 56, 192, 220, 185, 225, 113, 153, 236, 163, 61, 27, 214,
              91, 165, 227, 249, 82, 146, 53, 250, 51, 138, 121, 207, 28, 250,
              180, 216, 123, 127,
            ],
          ],
        },
        { name: "netuid", type: "u16", value: 117 },
        { name: "amount_staked", type: "u64", value: 741700000 },
      ]);
      assert.equal(
        out[0].value,
        "5DwRMxJG2KxxMXF9qqfc1NowJWKnY46QJHNf5R4CG9RozmGE",
      );
      // Sibling non-account typed fields are untouched by this fix.
      assert.equal(out[1].value, 117);
      assert.equal(out[2].value, 741700000);
    });

    test("Balances.transfer_keep_alive's top-level dest, a MultiAddress<AccountId32, ()> (real, block 8602605/18)", () => {
      const out = decode([
        {
          name: "dest",
          type: "MultiAddress<AccountId32, ()>",
          value: {
            name: "Id",
            values: [
              [
                [
                  180, 56, 69, 59, 155, 20, 102, 39, 96, 253, 195, 62, 155, 114,
                  113, 244, 236, 219, 6, 167, 180, 153, 46, 209, 55, 105, 249,
                  113, 25, 165, 243, 113,
                ],
              ],
            ],
          },
        },
        { name: "value", type: "Compact<u64>", value: 30000000 },
      ]);
      assert.equal(
        out[0].value,
        "5G91C6t2GywqvaBJmWRrmtmyFauai8pSDtyg6qA9X3Gw1uGF",
      );
    });

    test("a typed collection field (BTreeSet<NetUid>) is never mistaken for a byte blob at the top level", () => {
      // Guards the #4693 ambiguity this fix must not reopen: a
      // collection-typed descriptor's value stays an array at ANY element
      // count, even though a single netuid is shape-identical to a 1-byte
      // blob (isCollectionType's job, mirroring scale-normalize.mjs's
      // COLLECTION_TYPE_RE, applied before any byte-blob decode attempt).
      const out = decode([
        { name: "subnets", type: "BTreeSet<NetUid>", value: [104] },
      ]);
      assert.deepEqual(out[0].value, [104]);
    });

    test("SubtensorModule.commit_weights' top-level commit_hash, an H256 (real, block 8602444/9)", () => {
      // A non-account, non-collection typed byte-blob field: `type` rules
      // out both AccountId32/MultiAddress (isAccountId32Type) and a
      // collection generic (isCollectionType), so the byte-blob decode is
      // unambiguously safe regardless of nesting -- exercises the
      // topCall-only (no enclosing reconstructed call) branch of the
      // typed-descriptor byte-blob path.
      const out = decode([
        { name: "netuid", type: "u16", value: 10 },
        {
          name: "commit_hash",
          type: "H256",
          value: [
            [
              213, 57, 183, 176, 61, 250, 160, 19, 224, 152, 214, 79, 109, 80,
              105, 202, 162, 172, 175, 227, 217, 16, 133, 137, 40, 249, 62, 29,
              84, 71, 29, 149,
            ],
          ],
        },
      ]);
      assert.equal(
        out[1].value,
        "0xd539b7b03dfaa013e098d64f6d5069caa2acafe3d910858928f93e1d54471d95",
      );
    });

    test("a typed AccountId32 descriptor whose value isn't a decodable shape falls through unchanged, not to null", () => {
      // normalizeAccountId32Field returns null for a malformed value (here, a
      // 3-byte array -- neither a flat 32-byte AccountId32 nor a newtype/
      // MultiAddress wrap around one); the `?? value.value` fallback must
      // preserve the original raw value rather than silently nulling out a
      // field the caller can still inspect.
      const malformed = {
        name: "hotkey",
        type: "AccountId32",
        value: [1, 2, 3],
      };
      const out = decodePostgresCallArgs([malformed]);
      assert.deepEqual(out[0].value, [1, 2, 3]);
    });
  });

  describe("Sudo.sudo_unchecked_weight (synthetic -- 0 confirmed occurrences in the retention window; code path still exercised)", () => {
    test("reconstructs like any other single-nested call", () => {
      const raw = {
        call: {
          name: "Sudo",
          values: [
            {
              name: "sudo_unchecked_weight",
              values: {
                call: {
                  name: "SubtensorModule",
                  values: [
                    {
                      name: "set_root_claim_type",
                      values: {
                        new_root_claim_type: { name: "Swap", values: [] },
                      },
                    },
                  ],
                },
                weight: { ref_time: 100, proof_size: 10 },
              },
            },
          ],
        },
      };
      const out = decode(raw);
      assert.equal(out.call.call_module, "Sudo");
      assert.equal(out.call.call_function, "sudo_unchecked_weight");
      assert.deepEqual(out.call.call_args.call, {
        call_module: "SubtensorModule",
        call_function: "set_root_claim_type",
        call_args: { new_root_claim_type: "Swap" },
      });
      assert.deepEqual(out.call.call_args.weight, {
        ref_time: 100,
        proof_size: 10,
      });
    });
  });

  describe("account-key-named field whose value isn't a decodable AccountId32 shape", () => {
    test("falls through to the generic byte-blob/passthrough path instead of returning a decoded SS58", () => {
      // "hotkey" matches isAccountField, but a 3-byte array is neither a flat
      // 32-byte AccountId32 nor a newtype/MultiAddress wrap around one --
      // normalizeAccountId32Field returns null, so this must NOT short-circuit
      // on the account branch. It still happens to look like a tiny byte
      // blob, so it hex-encodes rather than passing through as a bare array
      // -- a defensible, non-crashing fallback for malformed input.
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [{ name: "transfer_stake", values: { hotkey: [1, 2, 3] } }],
        },
      };
      assert.equal(decode(raw).call.call_args.hotkey, "0x010203");
    });
  });

  describe("a reconstructed call whose own args are a bare byte blob with no field name", () => {
    test("decodeBytesField receives an empty field-name hint, not undefined -- still hex-encodes", () => {
      // nested.call_args here is the newtype-wrapped byte blob itself (not a
      // struct/array of named fields), so walk() recurses with keyHint left
      // undefined -- exercises decodeBytesField's `keyHint ?? ""` fallback.
      const raw = {
        call: {
          name: "SomeModule",
          values: [{ name: "raw_bytes_fn", values: [[1, 2, 3]] }],
        },
      };
      assert.equal(decode(raw).call.call_args, "0x010203");
    });
  });

  describe("ordering hazard: a genuinely zero-argument nested call", () => {
    test("is reconstructed with call_args:[], not collapsed to a bare function-name string", () => {
      // If normalizePostgresValue's C-like-unit-enum rule ran BEFORE this
      // module (the wrong order), {name:"fn",values:[]} would collapse to
      // the bare string "fn" -- structurally identical to a real C-like unit
      // enum (ProxyType::Any etc.) -- silently losing the nested-call
      // wrapper before reconstruction ever saw it. This proves the required
      // call order (decodePostgresCallArgs first) actually holds.
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [{ name: "some_zero_arg_fn", values: [] }],
        },
      };
      const out = decode(raw);
      assert.deepEqual(out.call, {
        call_module: "SubtensorModule",
        call_function: "some_zero_arg_fn",
        call_args: [],
      });
    });
  });

  describe("does not misidentify non-nested-call shapes (same disambiguation as extrinsics.ts's normalizeIndexerRsCall)", () => {
    test("an Option<T> Some wrapper (values[0] is an array, not an object) is left for normalizePostgresValue", () => {
      const raw = { name: "Some", values: [[0, 65535]] };
      assert.deepEqual(decode(raw), [0, 65535]);
    });

    test("a C-like unit enum (values is empty) is left for normalizePostgresValue", () => {
      assert.equal(decode({ name: "Any", values: [] }), "Any");
    });

    test("an enum-with-scalar-data node (values[0] is a bare scalar) is not reconstructed", () => {
      const raw = { name: "Something", values: [42] };
      assert.deepEqual(decodePostgresCallArgs(raw), {
        name: "Something",
        values: [42],
      });
    });

    test("an enum-with-struct-data node whose payload has no string .name (Ethereum's EIP1559 shape) is not reconstructed", () => {
      const raw = { name: "EIP1559", values: [{ nonce: 1, gas_price: 2 }] };
      assert.deepEqual(decodePostgresCallArgs(raw), raw);
    });

    test("a MultiAddress::Id wrapper is not reconstructed as a nested call (its payload is an array, not an object)", () => {
      const raw = {
        name: "Id",
        values: [
          [
            [
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
              20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
            ],
          ],
        ],
      };
      assert.equal(decodePostgresCallArgs(raw).name, "Id");
    });

    test("an Option<T> wrapping an enum-shaped T is NOT reconstructed as a nested call (real Drand.write_pulse signature, block 8543971/2) -- regression, caught during #4692", () => {
      // {name:"Some", values:[{name:"Sr25519", values:[bytes]}]} is
      // structurally IDENTICAL to a nested-call encoding (an outer
      // {name,values} node wrapping exactly one inner {name,values}-shaped
      // node) -- every #4691 fixture's Option-wrapped value lacked its own
      // string `.name`, so this ambiguity went untested until a real
      // Option<MultiSignature> fixture surfaced it. Without the "Some"/"None"
      // exclusion in tryReconstructNestedCall, this misreconstructs to
      // {call_module:"Some", call_function:"Sr25519", call_args:[bytes]}.
      const raw = {
        name: "Some",
        values: [{ name: "Sr25519", values: [[1, 2, 3]] }],
      };
      const out = decodePostgresCallArgs(raw);
      assert.equal("call_module" in out, false);
      assert.deepEqual(out, raw);
      // normalizePostgresValue then correctly Some-unwraps it, leaving the
      // bare Sr25519 enum-tree node for #4692's decoder to recognize.
      assert.deepEqual(decode(raw), { name: "Sr25519", values: [[1, 2, 3]] });
    });
  });

  describe("D1-shaped idempotence (must be a no-op on D1's own call_args shapes)", () => {
    test("leaves D1's {name,type,value} descriptor array untouched", () => {
      const d1CallArgs = [
        { name: "netuid", type: "NetUid", value: 9 },
        { name: "dests", type: "Vec<u16>", value: [21, 209] },
      ];
      assert.deepEqual(decodePostgresCallArgs(d1CallArgs), d1CallArgs);
    });

    test("leaves D1's own already-decoded nested-call shape untouched, including a real call_hash", () => {
      const d1NestedCall = {
        call_index: "0x1c00",
        call_module: "Balances",
        call_function: "transfer_keep_alive",
        call_args: [{ name: "dest", type: "MultiAddress", value: "5H..." }],
        call_hash:
          "0x4bf860882d143c4dc22bb5897dff810268789a297af20e5151cece736372d95",
      };
      assert.deepEqual(decodePostgresCallArgs(d1NestedCall), d1NestedCall);
    });
  });

  describe("edge cases", () => {
    test("passes through null/undefined/scalars without throwing", () => {
      assert.equal(decodePostgresCallArgs(null), null);
      assert.equal(decodePostgresCallArgs(undefined), undefined);
      assert.equal(decodePostgresCallArgs(42), 42);
      assert.equal(decodePostgresCallArgs("x"), "x");
      assert.equal(decodePostgresCallArgs(true), true);
    });

    test("passes through an empty array and empty object unchanged", () => {
      assert.deepEqual(decodePostgresCallArgs([]), []);
      assert.deepEqual(decodePostgresCallArgs({}), {});
    });

    test("a bare 32-byte AccountId32 array outside any reconstructed call now decodes via the ACCOUNT_KEYS name heuristic (fixed 2026-07-12; the old top-level scope boundary)", () => {
      const bytes = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      ];
      assert.deepEqual(decodePostgresCallArgs({ who: [bytes] }), {
        who: "5C62W7ELLAAfjCQeBU3me9ykaYomD8XTg2B9Hk6ki6Cm3v58",
      });
    });
  });
});
