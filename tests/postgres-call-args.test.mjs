import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodePostgresCallArgs } from "../src/postgres-call-args.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.ts";

// decodePostgresCallArgs must run BEFORE normalizePostgresValue (see
// src/postgres-call-args.mjs's own header for why) -- every test below
// chains them in that order, matching src/extrinsics.ts's formatExtrinsic.
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

    test("typed scalar newtype wrappers survive for normalizePostgresValue instead of being hex-encoded", () => {
      const out = decode([
        { name: "fee_rate", type: "Rate", value: [0] },
        { name: "small_count", type: "u32", value: [5] },
        { name: "large_count", type: "u32", value: [256] },
      ]);
      assert.equal(out[0].value, 0);
      assert.equal(out[1].value, 5);
      assert.equal(out[2].value, 256);
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

  describe("BTREESET_FIELDS exclusion (fixed 2026-07-12: a nested claim_root's subnets was being corrupted into an opaque hex string)", () => {
    test("leaves a nested SubtensorModule.claim_root's subnets untouched -- NOT hex-encoded by the generic byte-blob heuristic (real production fixture, block 8604111/11, Utility.batch)", () => {
      // Real raw shape confirmed via direct Postgres query: the pallet/
      // function enum-tree BEFORE reconstruction, one level down from
      // Utility.batch's own `calls` field.
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [
            { name: "claim_root", values: { subnets: [[1, 2, 3, 4, 5]] } },
          ],
        },
      };
      const out = decodePostgresCallArgs(raw);
      // Without the exclusion, unwrapByteArray/decodeBytesField would have
      // hex-encoded this into "0x0102030405" -- the array must survive
      // intact so decodeBTreeSetFields (postgres-collection-normalize.ts)
      // can still correctly unwrap it afterward.
      assert.deepEqual(out.call.call_args.subnets, [[1, 2, 3, 4, 5]]);
    });

    test("still hex-encodes a genuine byte-blob field with a different name inside the SAME nested call (the exclusion is scoped to the exact allowlisted field, not the whole call)", () => {
      const raw = {
        call: {
          name: "SubtensorModule",
          values: [
            {
              name: "claim_root",
              values: {
                subnets: [[1, 2, 3, 4, 5]],
                some_other_blob: [6, 7, 8],
              },
            },
          ],
        },
      };
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out.call.call_args.subnets, [[1, 2, 3, 4, 5]]);
      assert.equal(out.call.call_args.some_other_blob, "0x060708");
    });

    test("still hex-encodes a same-named field on a DIFFERENT nested call type -- scoped to (call_module, call_function, field), not field name alone", () => {
      const raw = {
        call: {
          name: "SomeOtherModule",
          values: [{ name: "some_function", values: { subnets: [1, 2, 3] } }],
        },
      };
      const out = decodePostgresCallArgs(raw);
      assert.equal(out.call.call_args.subnets, "0x010203");
    });
  });

  describe("nested enum-tree nodes (fixed 2026-07-12: a nested Option<u64> Some(0-255) was corrupted into a hex string)", () => {
    // Real raw shape confirmed via direct Postgres query, block 8606044/13:
    // a Utility.batch wrapping SubtensorModule.remove_stake_full_limit,
    // whose limit_price: Option<u64> arrives as this enum-tree node.
    const rawBatch = (limitPriceValue) => [
      {
        name: "calls",
        type: "Vec<RuntimeCall>",
        value: [
          {
            name: "SubtensorModule",
            values: [
              {
                name: "remove_stake_full_limit",
                values: {
                  hotkey: [
                    [
                      62, 34, 147, 208, 104, 248, 29, 37, 128, 200, 66, 207,
                      247, 252, 215, 171, 215, 140, 177, 84, 32, 140, 232, 171,
                      206, 168, 176, 128, 94, 80, 101, 113,
                    ],
                  ],
                  netuid: 10,
                  limit_price: limitPriceValue,
                },
              },
            ],
          },
        ],
      },
    ];

    test("a nested Option<u64> Some(0) decodes to the scalar 0, not a corrupted hex string (real block 8606044/13)", () => {
      const raw = rawBatch({ name: "Some", values: [0] });
      const out = decode(raw);
      assert.equal(out[0].value[0].call_args.limit_price, 0);
    });

    test("a nested Option<u64> Some(<256) decodes correctly for another small value (real block 8602712/8)", () => {
      // Every value 0-255 is shape-identical to a genuine 1-byte blob, so
      // this isn't just the 0 case -- confirm a couple more small values.
      for (const v of [1, 64, 255]) {
        const raw = rawBatch({ name: "Some", values: [v] });
        const out = decode(raw);
        assert.equal(out[0].value[0].call_args.limit_price, v);
      }
    });

    test("a nested Option<u64> Some(>255) still decodes correctly (real block 8601736/10, the pre-existing working baseline)", () => {
      const raw = rawBatch({ name: "Some", values: [32896091] });
      const out = decode(raw);
      assert.equal(out[0].value[0].call_args.limit_price, 32896091);
    });

    test("a nested Option<u64> None decodes to null", () => {
      const raw = rawBatch({ name: "None", values: [] });
      const out = decode(raw);
      assert.equal(out[0].value[0].call_args.limit_price, null);
    });

    test("a top-level (non-nested) Option<u64> Some(0) is unaffected -- already correct before this fix (real block 8606132/11)", () => {
      const raw = [
        {
          name: "limit_price",
          type: "Option<u64>",
          value: { name: "Some", values: [0] },
        },
      ];
      const out = decode(raw);
      // Top-level typed descriptors don't hit the nestedCall byte-blob
      // heuristic at all (nestedCall is null there) -- normalizePostgresValue
      // alone already unwraps Some(0) correctly via its generic pass.
      assert.equal(out[0].value, 0);
    });

    test("does not regress MultiAddress::Id decoding inside a nested call -- the same enum-tree shape, but account-keyed (real block 8605925/20's own Balances.transfer_keep_alive dest)", () => {
      const raw = {
        name: "calls",
        type: "Vec<RuntimeCall>",
        value: [
          {
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
                          2, 231, 237, 169, 77, 48, 47, 104, 42, 49, 75, 52,
                          183, 161, 133, 231, 62, 34, 120, 255, 67, 79, 133, 73,
                          252, 53, 179, 55, 34, 140, 130, 223,
                        ],
                      ],
                    ],
                  },
                  value: 1415000000,
                },
              },
            ],
          },
        ],
      };
      const out = decode(raw);
      assert.equal(
        out.value[0].call_args.dest,
        "5C8WrFofZBQWdEctJhwticZ2osjL7eVDeHyL5mE6V3AGx1VN",
      );
    });
  });

  describe("Vec<u8>/BoundedVec<u8> byte-blob-typed collections (fixed 2026-07-12: MevShield's ciphertext/enc_key were never hex-decoded, miscategorized as a generic collection)", () => {
    test("hex-encodes a bare BoundedVec<u8,_> field (real MevShield.submit_encrypted.ciphertext, block 8543969/7)", () => {
      const raw = [
        {
          name: "ciphertext",
          type: "BoundedVec<u8, _>",
          value: [[88, 203, 173, 120, 143]],
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value, "0x58cbad788f");
    });

    test("hex-encodes an Option<BoundedVec<u8,_>>::Some field (real MevShield.announce_next_key.enc_key, block 8543971/1)", () => {
      const raw = [
        {
          name: "enc_key",
          type: "Option<BoundedVec<u8, _>>",
          value: { name: "Some", values: [[[32, 103, 199, 46, 69]]] },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value, "0x2067c72e45");
    });

    test("decodes an Option<BoundedVec<u8,_>>::None field to null", () => {
      const raw = [
        {
          name: "enc_key",
          type: "Option<BoundedVec<u8, _>>",
          value: { name: "None", values: [] },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value, null);
    });

    test("leaves a genuine (non-u8) collection type untouched, still deferred to the generic array-recurse below", () => {
      const raw = [
        { name: "signers", type: "Vec<AccountId32>", value: [1, 2, 3] },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out[0].value, [1, 2, 3]);
    });

    test("is a no-op when the value matches neither the bare-array nor the Option-wrapped shape (malformed/defensive case)", () => {
      const raw = [
        { name: "ciphertext", type: "BoundedVec<u8, _>", value: 42 },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value, 42);
    });

    test("is a no-op on a Some-wrapped value whose payload isn't a byte array (malformed/defensive case)", () => {
      const raw = [
        {
          name: "enc_key",
          type: "Option<BoundedVec<u8, _>>",
          value: { name: "Some", values: [{ not: "bytes" }] },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out[0].value, {
        name: "Some",
        values: [{ not: "bytes" }],
      });
    });

    test("is a no-op on a malformed Some variant carrying more than one value (defensive case)", () => {
      const raw = [
        {
          name: "enc_key",
          type: "Option<BoundedVec<u8, _>>",
          value: {
            name: "Some",
            values: [
              [1, 2],
              [3, 4],
            ],
          },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out[0].value, {
        name: "Some",
        values: [
          [1, 2],
          [3, 4],
        ],
      });
    });
  });

  describe("LimitOrders signer/fee_recipient (fixed 2026-07-12: ACCOUNT_KEYS was missing these two)", () => {
    test("decodes signer and fee_recipient to SS58 inside a nested order struct (real production fixture, block 8587347/16)", () => {
      const signerBytes = new Array(32).fill(3);
      const raw = {
        orders: [
          [
            {
              order: {
                name: "V1",
                values: [
                  {
                    signer: [signerBytes],
                    fee_recipient: [signerBytes],
                    hotkey: [new Array(32).fill(4)],
                  },
                ],
              },
            },
          ],
        ],
      };
      const out = decodePostgresCallArgs(raw);
      const decoded = out.orders[0][0].order.values[0];
      assert.equal(typeof decoded.signer, "string");
      assert.ok(decoded.signer.startsWith("5"));
      assert.equal(decoded.signer, decoded.fee_recipient);
      assert.notEqual(decoded.signer, decoded.hotkey);
    });
  });

  describe("Multisig.approve_as_multi/as_multi other_signatories (fixed 2026-07-12: Vec<AccountId32> stayed raw byte arrays)", () => {
    test("decodes each entry of other_signatories to SS58 (real production fixture, block 4632809/7)", () => {
      const raw = [
        { name: "threshold", type: "u16", value: 2 },
        {
          name: "other_signatories",
          type: "Vec<AccountId32>",
          value: [
            [
              [
                52, 255, 249, 238, 218, 121, 67, 90, 186, 146, 46, 183, 175, 6,
                146, 64, 101, 217, 169, 111, 81, 96, 147, 188, 104, 1, 0, 156,
                67, 23, 174, 86,
              ],
            ],
            [
              [
                162, 215, 243, 37, 1, 85, 128, 30, 191, 174, 156, 92, 192, 213,
                34, 164, 121, 217, 17, 4, 153, 99, 4, 9, 190, 0, 74, 91, 83,
                131, 140, 52,
              ],
            ],
          ],
        },
        {
          name: "maybe_timepoint",
          type: "Option<Timepoint<u32>>",
          value: { name: "Some", values: [{ index: 7, height: 4632808 }] },
        },
        {
          name: "call_hash",
          type: "[u8; 32]",
          value: [
            6, 171, 78, 162, 128, 230, 11, 75, 28, 70, 147, 177, 247, 165, 165,
            113, 145, 156, 233, 147, 172, 84, 72, 55, 227, 80, 81, 46, 4, 157,
            139, 63,
          ],
        },
        {
          name: "max_weight",
          type: "Weight",
          value: { ref_time: 0, proof_size: 0 },
        },
      ];
      const out = decodePostgresCallArgs(raw, {
        call_module: "Multisig",
        call_function: "approve_as_multi",
      });
      const field = out.find((f) => f.name === "other_signatories");
      assert.deepEqual(field.value, [
        "5DGCPTWzKXExX2HTNsZpQNzmgWxbTZtBxqwP9ezpk882g98d",
        "5FkDmKc49rqCgCf4xsfuAcWE1qUui4vhTibMSC6LouFCi8US",
      ]);
      // call_hash is a hash, not an account -- must stay hex.
      const hashField = out.find((f) => f.name === "call_hash");
      assert.equal(
        normalizePostgresValue(hashField).value,
        "0x06ab4ea280e60b4b1c4693b1f7a5a571919ce993ac544837e350512e049d8b3f",
      );
    });
  });

  describe("SubtensorModule.set_children children tuple-nested AccountId32 (fixed 2026-07-12: the child's own account stayed a raw byte array)", () => {
    test("decodes each child tuple's AccountId32 slot to SS58 (real production fixture, block 8605286/512)", () => {
      const raw = [
        {
          name: "hotkey",
          type: "AccountId32",
          value: [
            [
              56, 190, 186, 205, 170, 242, 100, 142, 182, 91, 198, 146, 215,
              237, 72, 58, 84, 32, 140, 109, 76, 95, 243, 46, 207, 113, 61, 19,
              59, 170, 128, 17,
            ],
          ],
        },
        { name: "netuid", type: "u16", value: 80 },
        {
          name: "children",
          type: "Vec<(u64, AccountId32)>",
          value: [
            [
              // Number(...) rather than a raw literal: 18446744073709551615
              // (u64::MAX) already exceeds Number.MAX_SAFE_INTEGER, so a
              // literal of this exact value trips eslint's
              // no-loss-of-precision rule even though the rounding itself is
              // the deliberately-accepted, already-tested behavior below.
              Number("18446744073709551615"),
              [
                [
                  238, 231, 18, 242, 2, 200, 120, 232, 18, 157, 79, 64, 75, 233,
                  32, 237, 213, 155, 154, 95, 243, 100, 213, 231, 94, 249, 193,
                  31, 21, 125, 234, 98,
                ],
              ],
            ],
          ],
        },
      ];
      const out = decodePostgresCallArgs(raw, {
        call_module: "SubtensorModule",
        call_function: "set_children",
      });
      const field = out.find((f) => f.name === "children");
      assert.equal(field.value.length, 1);
      // proportion (tuple[0]) is untouched -- a separately accepted
      // float64-rounding precision invariant (#4693), not this fix's
      // concern (the raw u64::MAX literal itself already rounds on arrival,
      // matching tests/extrinsics.test.mjs:306's identical assertion).
      assert.equal(field.value[0][0], 18446744073709552000);
      assert.equal(
        field.value[0][1],
        "5HTwtytUfeUhK4p8NRCGppjUZrhJ5ckoRHeVWEQafg2N1Zo6",
      );
    });

    test("leaves a different call's Vec<(u64, AccountId32)>-shaped field untouched (narrow allowlist, not a generic tuple rule)", () => {
      const raw = [
        {
          name: "children",
          type: "Vec<(u64, AccountId32)>",
          value: [[1, [[9, 9, 9]]]],
        },
      ];
      const out = decodePostgresCallArgs(raw, {
        call_module: "SomeOtherModule",
        call_function: "some_other_function",
      });
      assert.deepEqual(out[0].value, [[1, [[9, 9, 9]]]]);
    });

    test("tolerates malformed/short tuple entries in children without throwing (defensive)", () => {
      const raw = [
        {
          name: "children",
          type: "Vec<(u64, AccountId32)>",
          value: [
            [1], // too short -- no account slot at all
            "not-a-tuple", // not even an array
            [2, [[9, 9, 9]]], // an array, but not a real 32-byte account
          ],
        },
      ];
      const out = decodePostgresCallArgs(raw, {
        call_module: "SubtensorModule",
        call_function: "set_children",
      });
      assert.deepEqual(out[0].value, [[1], "not-a-tuple", [2, [[9, 9, 9]]]]);
    });
  });

  describe("RawN identity-data variant family (fixed 2026-07-12: Commitments.set_commitment's info.fields[].RawN never decoded, nestedCall-gated heuristic never fires for a non-call struct field)", () => {
    test("UTF-8-decodes a Raw20 payload (real production fixture, block 8604175/9)", () => {
      const raw = [
        { name: "netuid", type: "u16", value: 89 },
        {
          name: "info",
          type: "CommitmentInfo<_>",
          value: {
            fields: [
              [
                {
                  name: "Raw20",
                  values: [
                    [
                      50, 59, 98, 59, 66, 84, 67, 44, 49, 46, 48, 49, 61, 48,
                      46, 49, 48, 52, 58, 49,
                    ],
                  ],
                },
              ],
            ],
          },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out[1].value.fields[0][0], {
        Raw20: "2;b;BTC,1.01=0.104:1",
      });
    });

    test("falls back to hex for malformed UTF-8 in a RawN payload", () => {
      const raw = { name: "Raw2", values: [[0xff, 0xfe]] };
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out, { Raw2: "0xfffe" });
    });

    test("is a no-op for a RawN-shaped node whose payload isn't a byte array", () => {
      const raw = { name: "Raw2", values: [{ not: "bytes" }] };
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out, raw);
    });

    test("does not misfire on an unrelated 2-key {name,values} node whose name doesn't match RawN", () => {
      const raw = { name: "NotRaw", values: [[1, 2]] };
      const out = decodePostgresCallArgs(raw);
      // NotRaw isn't RawN, so this falls through to the generic recursive
      // walk instead -- the byte array is untouched since there's no
      // nestedCall/typed-descriptor context here to trigger a byte-decode.
      assert.deepEqual(out, { name: "NotRaw", values: [[1, 2]] });
    });
  });

  describe("SubtensorModule.set_root_claim_type's struct-variant enum (fixed 2026-07-12: subnets kept an extra BTreeSet newtype-wrap layer)", () => {
    test("unwraps the extra layer on RootClaimTypeEnum::KeepSubnets.subnets (real production fixture)", () => {
      const raw = [
        {
          name: "new_root_claim_type",
          type: "RootClaimTypeEnum",
          value: { name: "KeepSubnets", values: { subnets: [[82, 97]] } },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.deepEqual(out[0].value, {
        name: "KeepSubnets",
        values: { subnets: [82, 97] },
      });
    });

    test("leaves a sibling field on the same struct-variant untouched", () => {
      const raw = [
        {
          name: "new_root_claim_type",
          type: "RootClaimTypeEnum",
          value: {
            name: "KeepSubnets",
            values: { subnets: [[82, 97]], note: "unrelated" },
          },
        },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value.values.note, "unrelated");
    });

    test("is a no-op when subnets is already unwrapped or absent", () => {
      const alreadyUnwrapped = [
        {
          name: "new_root_claim_type",
          type: "RootClaimTypeEnum",
          value: { name: "KeepSubnets", values: { subnets: [82, 97] } },
        },
      ];
      assert.deepEqual(
        decodePostgresCallArgs(alreadyUnwrapped)[0].value.values.subnets,
        [82, 97],
      );
      const noSubnets = [
        {
          name: "new_root_claim_type",
          type: "RootClaimTypeEnum",
          value: { name: "Unrestricted", values: {} },
        },
      ];
      assert.deepEqual(decodePostgresCallArgs(noSubnets)[0].value, {
        name: "Unrestricted",
        values: {},
      });
    });

    test("is a no-op on a non-struct-variant value for this type (defensive)", () => {
      const raw = [
        { name: "new_root_claim_type", type: "RootClaimTypeEnum", value: 42 },
      ];
      const out = decodePostgresCallArgs(raw);
      assert.equal(out[0].value, 42);
    });
  });
});
