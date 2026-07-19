import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  EVM_PRECOMPILE_BY_ADDRESS,
  decodeAbiArgs,
  decodeEvmPrecompileCall,
  findEvmPrecompile,
  functionSelector,
} from "../src/evm-precompiles.mjs";

function word(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

describe("evm-precompiles registry", () => {
  test("has exactly the 14 real ABI-dispatched precompile addresses", () => {
    assert.equal(EVM_PRECOMPILE_BY_ADDRESS.size, 14);
    assert.equal(
      EVM_PRECOMPILE_BY_ADDRESS.get(
        "0x0000000000000000000000000000000000000803",
      )?.name,
      "Subnet",
    );
    assert.equal(
      EVM_PRECOMPILE_BY_ADDRESS.get(
        "0x0000000000000000000000000000000000000801",
      )?.name,
      "Staking",
    );
    assert.equal(
      EVM_PRECOMPILE_BY_ADDRESS.get(
        "0x0000000000000000000000000000000000000805",
      )?.name,
      "StakingV2",
    );
  });

  test("every function has a unique selector within its own precompile", () => {
    for (const precompile of EVM_PRECOMPILE_BY_ADDRESS.values()) {
      const selectors = precompile.functions.map((f) => f.selector);
      assert.equal(
        new Set(selectors).size,
        selectors.length,
        `${precompile.name} has a duplicate selector`,
      );
      for (const fn of precompile.functions) {
        assert.equal(fn.argTypes.length, fn.argNames.length, fn.signature);
      }
    }
  });

  test("functionSelector matches known independently-verifiable ERC20 selectors", () => {
    // Not in this registry, but a hash-correctness check independent of
    // subtensor -- these two are among the most widely-verified selectors on
    // Ethereum (every ERC20 contract implements them the same way).
    assert.equal(functionSelector("transfer(address,uint256)"), "0xa9059cbb");
    assert.equal(functionSelector("balanceOf(address)"), "0x70a08231");
  });
});

describe("findEvmPrecompile", () => {
  test("finds a real precompile, case-insensitively", () => {
    assert.equal(
      findEvmPrecompile("0x0000000000000000000000000000000000000803")?.name,
      "Subnet",
    );
    assert.equal(
      findEvmPrecompile(
        "0x0000000000000000000000000000000000000803".toUpperCase(),
      )?.name,
      "Subnet",
    );
  });

  test("returns undefined for a non-precompile address or non-string input", () => {
    assert.equal(
      findEvmPrecompile("0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c"),
      undefined,
    );
    assert.equal(findEvmPrecompile(undefined), undefined);
    assert.equal(findEvmPrecompile(null), undefined);
    assert.equal(findEvmPrecompile(1234), undefined);
  });
});

describe("decodeAbiArgs", () => {
  test("decodes every static scalar type this registry uses", () => {
    const dataHex =
      "0x" +
      word("0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c") + // address
      word(1) + // bool (true)
      "ab".repeat(32) + // bytes32
      word(255) + // uint8
      word(65535) + // uint16
      word(4294967295) + // uint32
      word("18446744073709551615") + // uint64 (max)
      word(7); // uint128
    const args = decodeAbiArgs(
      [
        "address",
        "bool",
        "bytes32",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "uint128",
      ],
      ["a", "b", "c", "d", "e", "f", "g", "h"],
      dataHex,
    );
    assert.equal(args.a, "0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c");
    assert.equal(args.b, true);
    assert.equal(args.c, "0x" + "ab".repeat(32));
    assert.equal(args.d, 255);
    assert.equal(args.e, 65535);
    assert.equal(args.f, 4294967295);
    assert.equal(args.g, "18446744073709551615");
    assert.equal(args.h, "7");
  });

  test("decodes false and a zero uint256", () => {
    const dataHex = "0x" + word(0) + word(0);
    const args = decodeAbiArgs(["bool", "uint256"], ["flag", "n"], dataHex);
    assert.equal(args.flag, false);
    assert.equal(args.n, "0");
  });

  test("decodes a dynamic uint16[] array", () => {
    const dataHex =
      "0x" +
      word(32) + // offset to array data (right after this one head word)
      word(3) + // length
      word(10) +
      word(20) +
      word(30);
    const args = decodeAbiArgs(["uint16[]"], ["values"], dataHex);
    assert.deepEqual(args.values, [10, 20, 30]);
  });

  test("decodes an empty dynamic array", () => {
    const dataHex = "0x" + word(32) + word(0);
    const args = decodeAbiArgs(["uint8[]"], ["values"], dataHex);
    assert.deepEqual(args.values, []);
  });

  test("returns null for truncated head data", () => {
    assert.equal(decodeAbiArgs(["uint256"], ["n"], "0x0102"), null);
  });

  test("returns null when a dynamic array's offset points past the data", () => {
    const dataHex = "0x" + word(9999);
    assert.equal(decodeAbiArgs(["uint8[]"], ["values"], dataHex), null);
  });

  test("returns null when a dynamic array's declared length overruns the data", () => {
    const dataHex = "0x" + word(32) + word(5) + word(1); // length=5 but only 1 element present
    assert.equal(decodeAbiArgs(["uint16[]"], ["values"], dataHex), null);
  });

  test("returns null for a misaligned (non-word-multiple) offset", () => {
    const dataHex = "0x" + word(31);
    assert.equal(decodeAbiArgs(["uint8[]"], ["values"], dataHex), null);
  });

  test("returns null when the offset is aligned but the length word itself is missing", () => {
    // offset=32 (one word past the head slot) is validly aligned, but the
    // buffer ends exactly at the head slot -- there's no length word at all.
    const dataHex = "0x" + word(32);
    assert.equal(decodeAbiArgs(["uint8[]"], ["values"], dataHex), null);
  });

  test("returns null for an unrecognized static type", () => {
    assert.equal(decodeAbiArgs(["string"], ["s"], "0x" + word(0)), null);
  });

  test("decodes zero args", () => {
    assert.deepEqual(decodeAbiArgs([], [], "0x"), {});
  });
});

describe("decodeEvmPrecompileCall", () => {
  test("decodes a real precompile call end-to-end", () => {
    const precompile = EVM_PRECOMPILE_BY_ADDRESS.get(
      "0x0000000000000000000000000000000000000805",
    );
    const fn = precompile.functions.find(
      (f) => f.name === "getTotalHotkeyStake",
    );
    const inputHex = fn.selector + "ab".repeat(32);
    const result = decodeEvmPrecompileCall(
      "0x0000000000000000000000000000000000000805",
      inputHex,
    );
    assert.deepEqual(result, {
      precompile: "StakingV2",
      address: "0x0000000000000000000000000000000000000805",
      function: "getTotalHotkeyStake",
      signature: fn.signature,
      args: { hotkey: "0x" + "ab".repeat(32) },
    });
  });

  test("is case-insensitive on the `to` address", () => {
    const precompile = EVM_PRECOMPILE_BY_ADDRESS.get(
      "0x0000000000000000000000000000000000000805",
    );
    const fn = precompile.functions.find(
      (f) => f.name === "getNominatorMinRequiredStake",
    );
    const result = decodeEvmPrecompileCall(
      "0x0000000000000000000000000000000000000805".toUpperCase(),
      fn.selector,
    );
    assert.equal(result.function, "getNominatorMinRequiredStake");
    assert.deepEqual(result.args, {});
  });

  test("returns null for a non-precompile address", () => {
    assert.equal(
      decodeEvmPrecompileCall(
        "0x7e4c9cc4b96eeb035aa16f1a73df55252dc7055c",
        "0x12345678",
      ),
      null,
    );
  });

  test("identifies the precompile with function:null for an unrecognized selector", () => {
    const result = decodeEvmPrecompileCall(
      "0x0000000000000000000000000000000000000803",
      "0xffffffff",
    );
    assert.deepEqual(result, {
      precompile: "Subnet",
      address: "0x0000000000000000000000000000000000000803",
      function: null,
    });
  });

  test("identifies the precompile with function:null for non-hex input", () => {
    const result = decodeEvmPrecompileCall(
      "0x0000000000000000000000000000000000000803",
      "not-hex-data",
    );
    assert.deepEqual(result, {
      precompile: "Subnet",
      address: "0x0000000000000000000000000000000000000803",
      function: null,
    });
  });

  test("identifies the precompile with function:null for calldata shorter than a selector", () => {
    const result = decodeEvmPrecompileCall(
      "0x0000000000000000000000000000000000000803",
      "0x1234",
    );
    assert.deepEqual(result, {
      precompile: "Subnet",
      address: "0x0000000000000000000000000000000000000803",
      function: null,
    });
  });
});
