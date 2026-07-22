import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  decodeU256Limbs,
  decodeH160Bytes,
  decodeEthereumTransactArgs,
  decodeEvmWithdrawArgs,
  decodeSignatureFieldArgs,
  decodeEthereumEvmCallArgs,
} from "../src/indexer-rs-ethereum-decode.ts";
import { decodePostgresCallArgs } from "../src/postgres-call-args.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.ts";

// Full formatExtrinsic-equivalent pipeline, matching src/extrinsics.ts's
// actual call order (decodePostgresCallArgs -> normalizePostgresValue ->
// decodeEthereumEvmCallArgs).
function decode(callModule, callFunction, raw) {
  return decodeEthereumEvmCallArgs(
    callModule,
    callFunction,
    normalizePostgresValue(decodePostgresCallArgs(raw)),
  );
}

describe("decodeU256Limbs", () => {
  test("decodes a small value (real Ethereum.transact nonce, block 8587453/9)", () => {
    assert.equal(decodeU256Limbs([[69392, 0, 0, 0]]), "69392");
  });

  test("decodes zero", () => {
    assert.equal(decodeU256Limbs([[0, 0, 0, 0]]), "0");
  });

  test("decodes a value already past Number.MAX_SAFE_INTEGER losslessly (real 1.5 ETH transfer, block 8543743/20)", () => {
    // 1500000000000000000 wei = 1.5 ETH, confirmed via direct Postgres query
    // to already exceed Number.MAX_SAFE_INTEGER (9007199254740991) -- this is
    // the normal case for any transfer above ~0.009 ETH, not a remote edge
    // case at 2^256. limb0 alone carries the full value here since it's
    // still under 2^64.
    assert.equal(
      decodeU256Limbs([[1500000000000000000, 0, 0, 0]]),
      "1500000000000000000",
    );
  });

  test("decodes a value spanning multiple limbs (2^64 + 5)", () => {
    assert.equal(decodeU256Limbs([[5, 1, 0, 0]]), (2n ** 64n + 5n).toString());
  });

  test("decodes a value near 2^256 (synthetic -- no real data approaches this magnitude)", () => {
    // A true max limb (2^64-1) can't be written as an exact JS number literal
    // (it's past Number.MAX_SAFE_INTEGER) without the fixture itself already
    // being imprecise, so this uses the largest SAFE limb value in all 4
    // positions -- still exercises every limb contributing to the total via
    // its own bit-shift, just short of the true 2^256 ceiling.
    const limbs = [
      9007199254740991, 9007199254740991, 9007199254740991, 9007199254740991,
    ];
    const expected =
      BigInt(limbs[0]) +
      (BigInt(limbs[1]) << 64n) +
      (BigInt(limbs[2]) << 128n) +
      (BigInt(limbs[3]) << 192n);
    assert.equal(decodeU256Limbs([limbs]), expected.toString());
  });

  test("is a no-op on a value that isn't the wrapped-4-limb shape", () => {
    assert.equal(decodeU256Limbs(69392), 69392);
    assert.equal(decodeU256Limbs("69392"), "69392");
    assert.equal(decodeU256Limbs(null), null);
    assert.deepEqual(decodeU256Limbs([1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(decodeU256Limbs([[1, 2, 3]]), [[1, 2, 3]]);
  });

  test("is a no-op when one of the 4 limbs isn't a non-negative integer or a numeric string", () => {
    assert.deepEqual(decodeU256Limbs([[1, -1, 0, 0]]), [[1, -1, 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, 2.5, 0, 0]]), [[1, 2.5, 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, "abc", 0, 0]]), [[1, "abc", 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, "-2", 0, 0]]), [[1, "-2", 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, null, 0, 0]]), [[1, null, 0, 0]]);
  });

  describe("string-limb support (src/big-int-safe-json.mjs quotes a limb large enough to lose precision under plain JSON.parse)", () => {
    test("accepts a numeric-string limb the same as a number limb", () => {
      assert.equal(decodeU256Limbs([["69392", 0, 0, 0]]), "69392");
    });

    test("preserves exact precision when one limb arrives as a string (the real corruption case caught by Gittensory review)", () => {
      // 9131459485341369597 exceeds Number.MAX_SAFE_INTEGER -- this is exactly
      // the shape src/big-int-safe-json.ts's parseJsonPreservingBigInts
      // produces: the large limb pre-quoted as a string, the other 3 (small,
      // usually 0) limbs left as plain numbers.
      assert.equal(
        decodeU256Limbs([["9131459485341369597", 0, 0, 0]]),
        "9131459485341369597",
      );
    });

    test("combines a string limb with number limbs across multiple positions", () => {
      const expected =
        9131459485341369597n + (5n << 64n) + (3n << 128n) + (1n << 192n);
      assert.equal(
        decodeU256Limbs([["9131459485341369597", 5, 3, 1]]),
        expected.toString(),
      );
    });
  });
});

describe("decodeH160Bytes", () => {
  test("decodes a real address (EVM.withdraw, block 8573895/15)", () => {
    const wrapped = [
      [
        211, 47, 118, 124, 7, 153, 44, 49, 231, 209, 195, 129, 20, 9, 75, 146,
        116, 40, 240, 71,
      ],
    ];
    assert.equal(
      decodeH160Bytes(wrapped),
      "0xd32f767c07992c31e7d1c38114094b927428f047",
    );
  });

  test("decodes a flat (non-wrapped) 20-byte array", () => {
    const flat = [
      126, 76, 156, 196, 185, 110, 235, 3, 90, 161, 111, 26, 115, 223, 85, 37,
      45, 199, 5, 92,
    ];
    assert.equal(
      decodeH160Bytes(flat),
      "0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c",
    );
  });

  test("is a no-op on a non-20-byte value (e.g. a 32-byte hash, or an already-decoded D1 hex string)", () => {
    const hash32 = Array(32).fill(1);
    assert.deepEqual(decodeH160Bytes([hash32]), [hash32]);
    assert.equal(decodeH160Bytes("0xalready-hex"), "0xalready-hex");
  });
});

describe("decodeEthereumTransactArgs (real production fixture, block 8587453/9)", () => {
  const raw = {
    transaction: {
      name: "EIP1559",
      values: [
        {
          input: [97, 70, 25, 84],
          nonce: [[69392, 0, 0, 0]],
          value: [[0, 0, 0, 0]],
          action: {
            name: "Call",
            values: [
              [
                [
                  126, 76, 156, 196, 185, 110, 235, 3, 90, 161, 111, 26, 115,
                  223, 85, 37, 45, 199, 5, 92,
                ],
              ],
            ],
          },
          chain_id: 964,
          gas_limit: [[300000, 0, 0, 0]],
          signature: {
            r: [
              [
                8, 71, 174, 80, 131, 185, 205, 97, 210, 130, 20, 61, 150, 119,
                7, 123, 74, 227, 128, 243, 112, 107, 216, 158, 201, 141, 159,
                228, 40, 114, 48, 219,
              ],
            ],
            s: [
              [
                55, 72, 213, 45, 171, 108, 6, 125, 2, 51, 41, 15, 126, 129, 135,
                44, 190, 140, 220, 234, 168, 85, 223, 188, 22, 29, 64, 69, 198,
                186, 126, 108,
              ],
            ],
            odd_y_parity: true,
          },
          access_list: [],
          max_fee_per_gas: [[10000000000, 0, 0, 0]],
          max_priority_fee_per_gas: [[0, 0, 0, 0]],
        },
      ],
    },
  };

  test("decodes to D1's {transaction:{EIP1559:{...}}} shorthand with all fields correctly typed", () => {
    const out = decode("Ethereum", "transact", raw);
    assert.deepEqual(out.transaction.EIP1559, {
      input: [97, 70, 25, 84], // untouched -- D1's own mojibake bug is out of scope here
      nonce: "69392",
      value: "0",
      action: { Call: "0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c" },
      chain_id: 964,
      gas_limit: "300000",
      signature: {
        r: "0x0847ae5083b9cd61d282143d9677077b4ae380f3706bd89ec98d9fe4287230db",
        s: "0x3748d52dab6c067d0233290f7e81872cbe8cdceaa855dfbc161d4045c6ba7e6c",
        odd_y_parity: true,
      },
      access_list: [],
      max_fee_per_gas: "10000000000",
      max_priority_fee_per_gas: "0",
      // Not a known precompile address -- an ordinary contract call.
      precompile_call: null,
    });
  });

  test("decodes a Legacy transaction's gas_price (real production fixture, block 8604625/17, fixed 2026-07-12)", () => {
    // Found live while verifying #4933: TransactionV3::Legacy uses a single
    // gas_price U256 instead of EIP1559's dual max_fee_per_gas/
    // max_priority_fee_per_gas fee-market fields -- U256_FIELDS didn't list
    // it, so it stayed a raw 4-limb array while every other field decoded
    // correctly.
    const legacyRaw = {
      transaction: {
        name: "Legacy",
        values: [
          {
            input: [172, 30, 93, 191],
            nonce: [[1555, 0, 0, 0]],
            value: [[0, 0, 0, 0]],
            action: {
              name: "Call",
              values: [
                [
                  [
                    45, 121, 248, 109, 83, 187, 141, 203, 154, 206, 22, 32, 10,
                    219, 1, 78, 247, 227, 135, 61,
                  ],
                ],
              ],
            },
            gas_limit: [[150000, 0, 0, 0]],
            gas_price: [[10000000000, 0, 0, 0]],
            signature: {
              r: [
                [
                  179, 97, 128, 16, 14, 209, 76, 209, 215, 88, 24, 117, 168,
                  130, 228, 240, 229, 86, 14, 29, 46, 159, 224, 129, 224, 52,
                  248, 68, 179, 224, 104, 131,
                ],
              ],
              s: [
                [
                  112, 178, 135, 59, 14, 137, 89, 93, 207, 134, 232, 100, 105,
                  242, 238, 120, 85, 182, 108, 100, 7, 46, 79, 120, 5, 229, 105,
                  144, 92, 91, 166, 198,
                ],
              ],
              v: 1963,
            },
          },
        ],
      },
    };
    const out = decode("Ethereum", "transact", legacyRaw);
    assert.equal(out.transaction.Legacy.gas_price, "10000000000");
    assert.equal(out.transaction.Legacy.nonce, "1555");
    assert.equal(
      out.transaction.Legacy.action.Call,
      "0x2d79f86d53bb8dcb9ace16200adb014ef7e3873d",
    );
    assert.equal(out.transaction.Legacy.signature.v, 1963);
  });

  test("decodes the real production call_args shape -- an array of {name,type,value} descriptors, confirmed live 2026-07-12 (block 8604176/7)", () => {
    // This is what genuine indexer-rs/Postgres output actually looks like for
    // EVERY extrinsic (D1 is fully retired, #4772) -- decodeEthereumTransactArgs
    // previously assumed this shape meant "not Postgres's data, skip", making
    // it a 100% no-op in production. The `transaction` field lives inside a
    // {name,type,value} descriptor, not a flat top-level key.
    const descriptorShape = [
      {
        name: "transaction",
        type: "TransactionV3",
        value: raw.transaction,
      },
    ];
    const out = decodeEthereumTransactArgs(descriptorShape);
    assert.equal(Array.isArray(out), true);
    assert.equal(out[0].name, "transaction");
    assert.equal(out[0].type, "TransactionV3");
    assert.deepEqual(out[0].value.EIP1559.action, {
      Call: "0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c",
    });
    assert.equal(out[0].value.EIP1559.nonce, "69392");
    // Sibling descriptors (if any) pass through untouched.
    const withSibling = [
      { name: "unrelated", type: "u32", value: 42 },
      descriptorShape[0],
    ];
    const outWithSibling = decodeEthereumTransactArgs(withSibling);
    assert.deepEqual(outWithSibling[0], {
      name: "unrelated",
      type: "u32",
      value: 42,
    });
  });

  test("is a no-op when transaction is missing from either shape, or the descriptor array has no matching entry", () => {
    assert.deepEqual(decodeEthereumTransactArgs({}), {});
    assert.deepEqual(
      decodeEthereumTransactArgs({ transaction: { EIP1559: {} } }),
      {
        transaction: { EIP1559: {} },
      },
    );
    assert.equal(decodeEthereumTransactArgs(null), null);
    const noMatch = [{ name: "other_field", type: "u32", value: 1 }];
    assert.deepEqual(decodeEthereumTransactArgs(noMatch), noMatch);
  });

  test("passes a non-object EIP1559 payload through unchanged (malformed/defensive case)", () => {
    const malformed = {
      transaction: { name: "EIP1559", values: [42] },
    };
    assert.deepEqual(decodeEthereumTransactArgs(malformed), {
      transaction: { EIP1559: 42 },
    });
  });

  test("tolerates a transaction variant with an unexpected number of associated values (not reconstructed as EIP1559)", () => {
    const raw = { transaction: { name: "EIP1559", values: [] } };
    assert.deepEqual(decodeEthereumTransactArgs(raw), raw);
  });

  test("only decodes the U256/action/signature fields actually present, leaving a partial payload otherwise untouched", () => {
    const partial = {
      transaction: {
        name: "EIP1559",
        values: [{ chain_id: 964, nonce: [[1, 0, 0, 0]] }],
      },
    };
    assert.deepEqual(decodeEthereumTransactArgs(partial), {
      transaction: {
        EIP1559: { chain_id: 964, nonce: "1", precompile_call: null },
      },
    });
  });

  test("leaves a non-32-byte signature.r/s untouched (malformed/defensive case)", () => {
    const raw = {
      transaction: {
        name: "EIP1559",
        values: [
          {
            signature: { r: [1, 2, 3], s: "already-hex", odd_y_parity: false },
          },
        ],
      },
    };
    assert.deepEqual(decodeEthereumTransactArgs(raw), {
      transaction: {
        EIP1559: {
          signature: { r: [1, 2, 3], s: "already-hex", odd_y_parity: false },
          precompile_call: null,
        },
      },
    });
  });

  test("leaves a non-enum-tree-shaped action field untouched (malformed/defensive case)", () => {
    // Unlike the outer transaction field (pre-filtered by
    // decodeEthereumTransactArgs's own isEnumTreeNode guard before
    // decodeTupleVariantEnum is ever called), action has no such pre-filter
    // -- decodeTupleVariantEnum's own guard is the only gate here.
    const raw = {
      transaction: {
        name: "EIP1559",
        values: [{ action: "already-a-string" }],
      },
    };
    assert.deepEqual(decodeEthereumTransactArgs(raw), {
      transaction: {
        EIP1559: { action: "already-a-string", precompile_call: null },
      },
    });
  });

  describe("precompile_call (#6725/#6727)", () => {
    // StakingV2's real address (0x...805) and getTotalColdkeyStake(bytes32)'s
    // real selector, both from src/evm-precompiles.ts's own registry -- not
    // hand-transcribed here, so a registry change can never silently drift
    // this fixture out of sync with it.
    const STAKING_V2_ADDRESS = "0x0000000000000000000000000000000000000805";
    const STAKING_V2_FUNCTION = "getTotalColdkeyStake";

    function precompileCallTransaction(inputBytes) {
      return {
        transaction: {
          name: "EIP1559",
          values: [
            {
              input: inputBytes,
              action: {
                name: "Call",
                values: [
                  [
                    [
                      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8,
                      5,
                    ],
                  ],
                ],
              },
            },
          ],
        },
      };
    }

    test("decodes a real precompile call's calldata into named args", async () => {
      const { EVM_PRECOMPILE_BY_ADDRESS } =
        await import("../src/evm-precompiles.ts");
      const fn = EVM_PRECOMPILE_BY_ADDRESS.get(
        STAKING_V2_ADDRESS,
      ).functions.find((f) => f.name === STAKING_V2_FUNCTION);
      const coldkeyByte = 0xab;
      const selectorBytes = Array.from(
        Buffer.from(fn.selector.slice(2), "hex"),
      );
      const coldkeyBytes = Array(32).fill(coldkeyByte);
      const out = decodeEthereumTransactArgs(
        precompileCallTransaction([...selectorBytes, ...coldkeyBytes]),
      );
      assert.deepEqual(out.transaction.EIP1559.precompile_call, {
        precompile: "StakingV2",
        address: STAKING_V2_ADDRESS,
        function: STAKING_V2_FUNCTION,
        signature: fn.signature,
        args: { coldkey: "0x" + "ab".repeat(32) },
      });
      // `input` itself stays untouched -- precompile_call is additive.
      assert.deepEqual(out.transaction.EIP1559.input, [
        ...selectorBytes,
        ...coldkeyBytes,
      ]);
    });

    test("identifies a known precompile address with an unrecognized selector", () => {
      const out = decodeEthereumTransactArgs(
        precompileCallTransaction([0xff, 0xff, 0xff, 0xff]),
      );
      assert.deepEqual(out.transaction.EIP1559.precompile_call, {
        precompile: "StakingV2",
        address: STAKING_V2_ADDRESS,
        function: null,
      });
    });

    test("is null for calldata too short to carry a 4-byte selector", () => {
      const out = decodeEthereumTransactArgs(precompileCallTransaction([1, 2]));
      assert.deepEqual(out.transaction.EIP1559.precompile_call, {
        precompile: "StakingV2",
        address: STAKING_V2_ADDRESS,
        function: null,
      });
    });

    test("is null for an ordinary (non-precompile) contract address", () => {
      const raw = {
        transaction: {
          name: "EIP1559",
          values: [
            {
              input: [0x99, 0x85, 0x38, 0xc4],
              action: {
                name: "Call",
                values: [
                  [
                    [
                      126, 76, 156, 196, 185, 110, 235, 3, 90, 161, 111, 26,
                      115, 223, 85, 37, 45, 199, 5, 92,
                    ],
                  ],
                ],
              },
            },
          ],
        },
      };
      const out = decodeEthereumTransactArgs(raw);
      assert.equal(out.transaction.EIP1559.precompile_call, null);
    });

    test("is null for a Create action (no `to` to check)", () => {
      const raw = {
        transaction: {
          name: "EIP1559",
          values: [
            {
              input: [0x99, 0x85, 0x38, 0xc4],
              action: { name: "Create", values: [null] },
            },
          ],
        },
      };
      const out = decodeEthereumTransactArgs(raw);
      assert.equal(out.transaction.EIP1559.precompile_call, null);
    });
  });
});

describe("decodeEvmWithdrawArgs (real production fixture, block 8573895/15)", () => {
  test("decodes address to hex, leaves value untouched (a native-currency amount, not U256)", () => {
    const raw = {
      value: 67756440,
      address: [
        [
          211, 47, 118, 124, 7, 153, 44, 49, 231, 209, 195, 129, 20, 9, 75, 146,
          116, 40, 240, 71,
        ],
      ],
    };
    assert.deepEqual(decode("EVM", "withdraw", raw), {
      value: 67756440,
      address: "0xd32f767c07992c31e7d1c38114094b927428f047",
    });
  });

  test("is a no-op when address is absent, and leaves an already-hex address untouched", () => {
    assert.deepEqual(decodeEvmWithdrawArgs({ value: 1 }), { value: 1 });
    const alreadyHex = [{ name: "address", type: "H160", value: "0x..." }];
    assert.deepEqual(decodeEvmWithdrawArgs(alreadyHex), alreadyHex);
    const noMatch = [{ name: "value", type: "u128", value: 1 }];
    assert.deepEqual(decodeEvmWithdrawArgs(noMatch), noMatch);
  });

  test("decodes the real production call_args shape -- an array of {name,type,value} descriptors", () => {
    const descriptorShape = [
      { name: "value", type: "u128", value: 67756440 },
      {
        name: "address",
        type: "H160",
        value: [
          [
            211, 47, 118, 124, 7, 153, 44, 49, 231, 209, 195, 129, 20, 9, 75,
            146, 116, 40, 240, 71,
          ],
        ],
      },
    ];
    const out = decodeEvmWithdrawArgs(descriptorShape);
    assert.deepEqual(out[0], { name: "value", type: "u128", value: 67756440 });
    assert.deepEqual(out[1], {
      name: "address",
      type: "H160",
      value: "0xd32f767c07992c31e7d1c38114094b927428f047",
    });
  });
});

describe("decodeSignatureFieldArgs", () => {
  test("decodes LimitOrders.execute_batched_orders' nested signature (real production fixture, block 8587347/16)", () => {
    const raw = {
      netuid: 71,
      orders: [
        [
          {
            order: { name: "V1", values: [{ limit_price: 5888441 }] },
            signature: {
              name: "Sr25519",
              values: [
                [
                  150, 11, 211, 2, 35, 114, 0, 219, 83, 224, 23, 73, 4, 11, 105,
                  77, 181, 36, 146, 170, 87, 211, 46, 110, 18, 183, 246, 16, 37,
                  147, 87, 121, 140, 28, 231, 228, 214, 168, 22, 120, 201, 143,
                  193, 100, 165, 76, 63, 174, 94, 13, 50, 45, 252, 173, 211, 94,
                  23, 249, 44, 150, 98, 104, 48, 139,
                ],
              ],
            },
            partial_fill: { name: "None", values: [] },
          },
        ],
      ],
    };
    const out = decode("LimitOrders", "execute_batched_orders", raw);
    assert.deepEqual(out.orders[0][0].signature, {
      Sr25519:
        "0x960bd302237200db53e01749040b694db52492aa57d32e6e12b7f610259357798c1ce7e4d6a81678c98fc164a54c3fae5e0d322dfcadd35e17f92c966268308b",
    });
    // Sibling fields untouched by this decoder (out of #4692's scope).
    assert.equal(out.netuid, 71);
    assert.equal(out.orders[0][0].partial_fill, null);
  });

  test("decodes Drand.write_pulse's top-level Option-wrapped signature (real production fixture, block 8543971/2)", () => {
    const raw = {
      signature: {
        name: "Some",
        values: [
          {
            name: "Sr25519",
            values: [
              [
                132, 185, 151, 13, 196, 53, 78, 98, 152, 163, 237, 123, 202, 6,
                153, 146, 216, 96, 29, 147, 184, 14, 12, 119, 148, 197, 197, 85,
                251, 45, 114, 126, 160, 35, 1, 194, 136, 27, 171, 210, 21, 6,
                156, 198, 204, 127, 170, 185, 118, 81, 53, 215, 218, 54, 128,
                216, 69, 6, 142, 249, 24, 165, 93, 141,
              ],
            ],
          },
        ],
      },
      pulses_payload: {
        // A DIFFERENT field that also uses the Sr25519 shape (a MultiSigner
        // public key, not a MultiSignature) -- decoded the same way, since
        // "public" is now a matched key alongside "signature"/"randomness".
        public: { name: "Sr25519", values: [[1, 2, 3, 4]] },
      },
    };
    const out = decode("Drand", "write_pulse", raw);
    assert.deepEqual(out.signature, {
      Sr25519:
        "0x84b9970dc4354e6298a3ed7bca069992d8601d93b80e0c7794c5c555fb2d727ea02301c2881babd215069cc6cc7faab9765135d7da3680d845068ef918a55d8d",
    });
    assert.deepEqual(out.pulses_payload.public, {
      Sr25519: "0x01020304",
    });
  });

  test("decodes Drand.write_pulse's per-pulse signature/randomness -- bare 32-byte arrays, NOT Sr25519-enum-wrapped (real production fixture, block 8604176)", () => {
    const raw = {
      pulses_payload: {
        pulses: [
          {
            round: 30347496,
            signature: [
              [
                146, 56, 3, 31, 123, 237, 132, 59, 123, 234, 164, 93, 97, 46,
                156, 91, 23, 39, 177, 160, 170, 10, 92, 222, 197, 83, 161, 45,
                20, 120, 163, 1,
              ],
            ],
            randomness: [
              [
                240, 33, 67, 144, 32, 232, 205, 35, 16, 13, 65, 216, 92, 171,
                251, 103, 72, 7, 98, 149, 253, 169, 154, 217, 2, 11, 177, 42,
                234, 132, 67, 65,
              ],
            ],
          },
        ],
      },
    };
    const out = decode("Drand", "write_pulse", raw);
    assert.equal(
      out.pulses_payload.pulses[0].signature,
      "0x9238031f7bed843b7beaa45d612e9c5b1727b1a0aa0a5cdec553a12d1478a301",
    );
    assert.equal(
      out.pulses_payload.pulses[0].randomness,
      "0xf021439020e8cd23100d41d85cabfb6748076295fda99ad9020bb12aea844341",
    );
    assert.equal(out.pulses_payload.pulses[0].round, 30347496);
  });

  test("is a no-op on D1's own already-decoded {Sr25519: hex} shorthand", () => {
    const alreadyDecoded = { signature: { Sr25519: "0x1234" } };
    assert.deepEqual(decodeSignatureFieldArgs(alreadyDecoded), alreadyDecoded);
  });

  test("declines a signature field with a different (unevidenced) variant name rather than guessing its payload shape", () => {
    const raw = { signature: { name: "Ed25519", values: [[1, 2, 3]] } };
    assert.deepEqual(decodeSignatureFieldArgs(raw), raw);
  });

  test("leaves an Sr25519-tagged signature untouched when its payload isn't a byte array (malformed/defensive case)", () => {
    const raw = { signature: { name: "Sr25519", values: [{ not: "bytes" }] } };
    assert.deepEqual(decodeSignatureFieldArgs(raw), raw);
  });

  test("decodes the TOP-LEVEL signature against the real descriptor-array call_args shape (fixed 2026-07-12, real production fixture, block 8605291/5)", () => {
    // Found live 2026-07-12: unlike the flat-object fixture above, real
    // call_args is a descriptor ARRAY -- the top-level `signature` field
    // arrives as {name:"signature", type:"Option<MultiSignature>",
    // value:{...}}, not a literal object key named "signature". The generic
    // key-matching loop in walkForSignatureFields never recognized this
    // descriptor as representing the signature field, so it stayed
    // completely raw despite the identical-looking flat-object test above
    // passing the whole time.
    const raw = [
      {
        name: "pulses_payload",
        type: "PulsesPayload<MultiSigner, u32>",
        value: {
          public: {
            name: "Sr25519",
            values: [
              [
                214, 13, 49, 183, 157, 175, 40, 221, 225, 104, 187, 249, 129,
                82, 106, 18, 60, 124, 104, 159, 226, 111, 192, 13, 146, 73, 7,
                64, 62, 212, 0, 35,
              ],
            ],
          },
          pulses: [
            {
              round: 30351957,
              signature: [
                [
                  164, 69, 3, 150, 91, 10, 102, 28, 75, 20, 154, 78, 140, 231,
                  52, 248, 186, 241, 43, 219, 170, 160, 94, 167, 131, 145, 168,
                  8, 60, 53, 199, 90, 102, 43, 128, 110, 128, 171, 178, 230,
                  161, 207, 175, 47, 85, 234, 50, 49,
                ],
              ],
              randomness: [
                [
                  65, 86, 219, 252, 253, 21, 250, 126, 87, 222, 32, 237, 220,
                  176, 74, 199, 12, 172, 25, 41, 209, 180, 142, 181, 250, 118,
                  118, 124, 117, 98, 212, 59,
                ],
              ],
            },
          ],
          block_number: 8605290,
        },
      },
      {
        name: "signature",
        type: "Option<MultiSignature>",
        value: {
          name: "Some",
          values: [
            {
              name: "Sr25519",
              values: [
                [
                  70, 3, 96, 108, 107, 125, 0, 151, 142, 139, 67, 132, 42, 212,
                  154, 58, 9, 217, 244, 135, 155, 223, 51, 110, 122, 166, 243,
                  18, 60, 210, 229, 116, 68, 26, 55, 64, 190, 27, 217, 154, 208,
                  79, 92, 189, 16, 68, 17, 139, 197, 43, 236, 81, 7, 123, 245,
                  223, 24, 14, 84, 54, 33, 240, 46, 135,
                ],
              ],
            },
          ],
        },
      },
    ];
    const out = decode("Drand", "write_pulse", raw);
    const signatureField = out.find((f) => f.name === "signature");
    assert.deepEqual(signatureField.value, {
      Sr25519:
        "0x4603606c6b7d00978e8b43842ad49a3a09d9f4879bdf336e7aa6f3123cd2e574441a3740be1bd99ad04f5cbd1044118bc52bec51077bf5df180e543621f02e87",
    });
    // pulses[0].signature is a 48-byte BLS12-381 G1 point (NOT 32 bytes like
    // its randomness sibling) -- decodeHash32Bytes' hardcoded length===32
    // check silently left it raw before this fix, while randomness (32
    // bytes) coincidentally already worked.
    const pulsesField = out.find((f) => f.name === "pulses_payload");
    const pulse = pulsesField.value.pulses[0];
    assert.equal(
      pulse.signature,
      "0xa44503965b0a661c4b149a4e8ce734f8baf12bdbaaa05ea78391a8083c35c75a662b806e80abb2e6a1cfaf2f55ea3231",
    );
    assert.equal(
      pulse.randomness,
      "0x4156dbfcfd15fa7e57de20eddcb04ac70cac1929d1b48eb5fa76767c7562d43b",
    );
    assert.deepEqual(pulsesField.value.public, {
      Sr25519:
        "0xd60d31b79daf28dde168bbf981526a123c7c689fe26fc00d924907403ed40023",
    });
  });

  test("decodes a top-level typed-descriptor field literally named 'public' the same way (defensive -- not confirmed live at the top level, but the same descriptor-recognition branch as signature/randomness)", () => {
    const raw = [
      {
        name: "public",
        type: "MultiSigner",
        value: { name: "Sr25519", values: [[1, 2, 3, 4]] },
      },
    ];
    const out = decode("Drand", "write_pulse", raw);
    assert.deepEqual(out.find((f) => f.name === "public").value, {
      Sr25519: "0x01020304",
    });
  });
});

describe("decodeDynamicFeeArgs (fixed 2026-07-12: DynamicFee.note_min_gas_price_target wasn't in DECODERS at all)", () => {
  test("decodes target (U256) to an exact decimal string, not raw hex (real production fixture, block 4633999/1)", () => {
    // Found live 2026-07-12: `target` (real value 1, raw 4-limb array
    // [1,0,0,0]) was actively WRONG in served output -- "0x01000000"
    // (16,777,216) -- because this call type was missing from DECODERS
    // entirely, AND (a deeper bug in the shared pipeline) postgres-call-
    // args.mjs's typed-descriptor branch eagerly byte-blob-hex-encoded any
    // top-level U256-typed field before this module ever got a chance to
    // run, whenever every limb happened to look like a valid byte (0-255).
    const raw = [{ name: "target", type: "U256", value: [[1, 0, 0, 0]] }];
    const out = decode("DynamicFee", "note_min_gas_price_target", raw);
    assert.equal(out.find((f) => f.name === "target").value, "1");
  });

  test("decodes a target whose limb exceeds 255 correctly too (would have stayed completely raw, not just wrong, under the old byte-blob path)", () => {
    const raw = [
      { name: "target", type: "U256", value: [[20000000000, 0, 0, 0]] },
    ];
    const out = decode("DynamicFee", "note_min_gas_price_target", raw);
    assert.equal(out.find((f) => f.name === "target").value, "20000000000");
  });

  test("is a no-op when target isn't found (defensive)", () => {
    const raw = [{ name: "unrelated", type: "u32", value: 1 }];
    const out = decode("DynamicFee", "note_min_gas_price_target", raw);
    assert.deepEqual(out, raw);
  });
});

describe("decodeEthereumEvmCallArgs dispatch", () => {
  test("MevShield is NOT in the dispatch table -- verified against real production data, not assumed", () => {
    // Requirement 4 flagged MevShield as a "probable" third Signature::Sr25519
    // user. Direct verification against real data (block 8543969/7
    // submit_encrypted, block 8543971/1 announce_next_key) shows neither
    // function has a signature field at all: submit_encrypted's sole arg is
    // a raw ciphertext byte blob, announce_next_key's is an Option-wrapped
    // encryption public key. The probable-user note doesn't hold up.
    const submitEncrypted = { ciphertext: [[1, 2, 3]] };
    assert.deepEqual(
      decodeEthereumEvmCallArgs(
        "MevShield",
        "submit_encrypted",
        submitEncrypted,
      ),
      submitEncrypted,
    );
    const announceNextKey = {
      enc_key: { name: "Some", values: [[[1, 2, 3]]] },
    };
    assert.deepEqual(
      decodeEthereumEvmCallArgs(
        "MevShield",
        "announce_next_key",
        announceNextKey,
      ),
      announceNextKey,
    );
  });

  test("is a no-op for any call type with no registered decoder", () => {
    const raw = { some_field: 42 };
    assert.deepEqual(
      decodeEthereumEvmCallArgs("SubtensorModule", "transfer_stake", raw),
      raw,
    );
  });
});
