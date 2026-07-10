import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  decodeU256Limbs,
  decodeH160Bytes,
  decodeEthereumTransactArgs,
  decodeEvmWithdrawArgs,
  decodeSignatureFieldArgs,
  decodeEthereumEvmCallArgs,
} from "../src/indexer-rs-ethereum-decode.mjs";
import { decodePostgresCallArgs } from "../src/postgres-call-args.mjs";
import { normalizePostgresValue } from "../src/scale-normalize.mjs";

// Full formatExtrinsic-equivalent pipeline, matching src/extrinsics.mjs's
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

  test("is a no-op when one of the 4 limbs isn't a non-negative integer", () => {
    assert.deepEqual(decodeU256Limbs([[1, -1, 0, 0]]), [[1, -1, 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, 2.5, 0, 0]]), [[1, 2.5, 0, 0]]);
    assert.deepEqual(decodeU256Limbs([[1, "2", 0, 0]]), [[1, "2", 0, 0]]);
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
    });
  });

  test("is a no-op on D1's own call_args shape (an array of {name,type,value} descriptors has no .transaction property)", () => {
    const d1Shape = [
      { name: "transaction", type: "Transaction", value: { EIP1559: {} } },
    ];
    assert.deepEqual(decodeEthereumTransactArgs(d1Shape), d1Shape);
  });

  test("is a no-op when transaction is missing or already D1-shaped", () => {
    assert.deepEqual(decodeEthereumTransactArgs({}), {});
    assert.deepEqual(
      decodeEthereumTransactArgs({ transaction: { EIP1559: {} } }),
      {
        transaction: { EIP1559: {} },
      },
    );
    assert.equal(decodeEthereumTransactArgs(null), null);
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
      transaction: { EIP1559: { chain_id: 964, nonce: "1" } },
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
      transaction: { EIP1559: { action: "already-a-string" } },
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

  test("is a no-op when address is absent or already D1-shaped", () => {
    assert.deepEqual(decodeEvmWithdrawArgs({ value: 1 }), { value: 1 });
    const d1Shape = [{ name: "address", type: "H160", value: "0x..." }];
    assert.deepEqual(decodeEvmWithdrawArgs(d1Shape), d1Shape);
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
        // A DIFFERENT field that happens to also be Sr25519-shaped (a
        // MultiSigner public key, not a MultiSignature) -- deliberately left
        // untouched, confirming decodeSignatureFieldArgs only targets keys
        // literally named "signature", not any Sr25519-shaped value anywhere.
        public: { name: "Sr25519", values: [[1, 2, 3, 4]] },
      },
    };
    const out = decode("Drand", "write_pulse", raw);
    assert.deepEqual(out.signature, {
      Sr25519:
        "0x84b9970dc4354e6298a3ed7bca069992d8601d93b80e0c7794c5c555fb2d727ea02301c2881babd215069cc6cc7faab9765135d7da3680d845068ef918a55d8d",
    });
    assert.deepEqual(out.pulses_payload.public, {
      name: "Sr25519",
      values: [[1, 2, 3, 4]],
    });
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
