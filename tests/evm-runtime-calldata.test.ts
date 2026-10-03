import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeRuntimeEvmCall } from "../src/evm-runtime-calldata.ts";
import { evmRuntimeCatalogue as catalogue } from "../src/evm-runtime-catalogue.ts";
import { functionSelector } from "../src/evm-precompiles.ts";
import { DecodeEvmCallOutputSchema } from "../schemas-src/mcp-tools/evm.ts";
import reference from "./fixtures/evm-runtime-reference.ts";

const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
const word = (value: number | bigint) =>
  BigInt(value).toString(16).padStart(64, "0");
const source = {
  runtime_spec_version: 470,
  source_commit: "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d",
};

test("every release-bound precompile function decodes its independently encoded reference arguments", () => {
  assert.equal(reference.reference.version, "ethers@6.15.0");
  assert.equal(catalogue.releases.length, 91);
  assert.equal(reference.vectors.length, catalogue.functions.length);
  let cases = 0;
  for (const release of catalogue.releases) {
    const manifest = reference.manifests.find(
      (row) => row.spec === release[0],
    )!;
    assert.equal(release[2].length, manifest.addresses);
    assert.equal(
      new Set(release[2].map((id) => catalogue.precompiles[id][1])).size,
      release[2].length,
    );
    if (release[0] !== 205) {
      assert.equal(
        release[2]
          .map((id) => catalogue.precompiles[id])
          .find((row) => row[0] === "Staking")![1],
        2049,
      );
    }
    if (release[0] >= 430) {
      assert.equal(
        release[2]
          .map((id) => catalogue.precompiles[id])
          .find((row) => row[0] === "StakingV2")![1],
        2053,
      );
    }
    assert.ok(manifest.files.every((row) => /^[0-9a-f]{64}$/.test(row[1])));
    let functions = 0;
    for (const id of release[2]) {
      const entry = catalogue.precompiles[id];
      assert.ok(entry[1] >= 0 && entry[1] <= 65535);
      assert.equal(
        new Set(entry[2].map((index) => catalogue.functions[index][2])).size,
        entry[2].length,
      );
      for (const index of entry[2]) {
        const fn = catalogue.functions[index];
        assert.equal(new Set(fn[1]).size, fn[1].length);
        const [input, values] = reference.vectors[index];
        assert.equal(functionSelector(fn[0]), fn[2]);
        assert.equal(input.slice(0, 10), fn[2]);
        const result = decodeRuntimeEvmCall(
          release[0],
          address(entry[1]),
          input,
        )!;
        assert.deepEqual(
          result,
          {
            precompile: entry[0],
            address: address(entry[1]),
            function: fn[0].split("(")[0],
            runtime_spec_version: release[0],
            source_commit: release[1],
            signature: fn[0],
            args: Object.fromEntries(
              fn[1].map((name, offset) => [name, values[offset]]),
            ),
          },
          `${release[0]} ${entry[0]} ${fn[0]}`,
        );
        DecodeEvmCallOutputSchema.parse(result);
        cases += 1;
        functions += 1;
      }
    }
    assert.equal(functions, manifest.functions);
  }
  const repeated = JSON.stringify(
    catalogue.releases.map((release) => [
      release[0],
      release[1],
      release[2].map((id) => {
        const entry = catalogue.precompiles[id];
        return [
          entry[0],
          entry[1],
          entry[2].map((index) => catalogue.functions[index]),
        ];
      }),
    ]),
  );
  console.log(
    "EVM_CATALOGUE_COMPACT_FIXTURE",
    JSON.stringify({
      releases: catalogue.releases.length,
      prepared_reference_decode_cases: cases,
      shared_catalogue_bytes: Buffer.byteLength(JSON.stringify(catalogue)),
      repeated_catalogue_bytes: Buffer.byteLength(repeated),
      runtime_selector_hashes: 0,
      fixture: true,
      production: false,
    }),
  );
});

test("version selection retains old bindings, identifies raw precompiles and declines unknown releases/addresses/selectors", () => {
  assert.equal(
    decodeRuntimeEvmCall(470, `0x${"ab".repeat(20)}`, "0xffffffff")!.precompile,
    null,
  );
  assert.equal(
    decodeRuntimeEvmCall(472, address(2053), "0x00000000"),
    undefined,
  );
  assert.equal(
    decodeRuntimeEvmCall(436, address(2053), "0x00000000"),
    undefined,
  );
  assert.deepEqual(decodeRuntimeEvmCall(470, address(9999), "0xffffffff"), {
    precompile: null,
    address: null,
    function: null,
    ...source,
  });
  assert.deepEqual(decodeRuntimeEvmCall(470, address(2065), "0xffffffff"), {
    precompile: "Timestamp",
    address: address(2065),
    function: null,
    ...source,
  });
  const timestamp = functionSelector("getTimestamp()");
  assert.equal(
    decodeRuntimeEvmCall(430, address(2065), timestamp)!.precompile,
    null,
  );
  assert.equal(
    decodeRuntimeEvmCall(
      470,
      address(2065).toUpperCase().replace("0X", "0x"),
      timestamp.toUpperCase().replace("0X", "0x"),
    )!.function,
    "getTimestamp",
  );
  for (const input of ["0x", "0x1", "0x1234567g", `${timestamp}1`]) {
    assert.equal(
      decodeRuntimeEvmCall(470, address(2065), input)!.function,
      null,
    );
  }
  const raw = decodeRuntimeEvmCall(470, address(1026), "0x00000000")!;
  assert.equal(raw.precompile, "Ed25519Verify");
  assert.equal(raw.function, null);
});

function decode(signature: string, data: string, index = 2053) {
  return decodeRuntimeEvmCall(
    470,
    address(index),
    `${functionSelector(signature)}${data}`,
  )!;
}
test("exact scalar admission rejects dirty addresses, bools, fixed bytes and narrow integer overflow", () => {
  assert.equal(
    decode("setRejectLockedAlpha(bool)", word(0)).args!.enabled,
    false,
  );
  for (const value of [2n, 1n << 255n])
    assert.equal(decode("setRejectLockedAlpha(bool)", word(value)).args, null);
  assert.equal(
    decode("setRootClaimThreshold(uint16,uint64)", word(65536) + word(1)).args,
    null,
  );
  assert.equal(
    decode(
      "getPrecompileStatus(address,bytes4)",
      word(1n << 160n) + "ab".repeat(4) + "00".repeat(28),
      2067,
    ).args,
    null,
  );
  assert.equal(
    decode(
      "getPrecompileStatus(address,bytes4)",
      word(1) + "ab".repeat(4) + "00".repeat(27) + "01",
      2067,
    ).args,
    null,
  );
  assert.equal(
    decode(
      "addStake(bytes32,uint256,uint256)",
      "ab".repeat(32) + word((1n << 256n) - 1n) + word(7),
    ).args!.amount_rao,
    ((1n << 256n) - 1n).toString(),
  );
  assert.equal(
    decode("addStake(bytes32,uint256,uint256)", "00".repeat(32)).args,
    null,
  );
});

test("dynamic tails are bounded before allocation and use each nested array's relative head", () => {
  const signature = "claimRoot(uint16[])";
  assert.deepEqual(decode(signature, word(32) + word(0)).args, { subnets: [] });
  for (const data of [
    word(0),
    word(31),
    word(64),
    word(1n << 200n),
    word(32) + word(1n << 200n),
    word(32) + word(2) + word(7),
    word(32) + word(1) + word(65536),
  ])
    assert.equal(decode(signature, data).args, null);
  assert.equal(
    decode(signature, word(32) + word(1) + word(7) + "00".repeat(32768)).args,
    null,
  );
  const nested = "batchSetWeights(uint16[],uint16[][],uint16[][],uint64[])";
  const id = catalogue.functions.findIndex((row) => row[0] === nested);
  const data = reference.vectors[id][0].slice(10);
  assert.equal(decode(nested, data, 2052).args === null, false);
  // First nested array's first element cannot point back into its own head.
  const offset = Number(BigInt(`0x${data.slice(64, 128)}`));
  const broken =
    data.slice(0, (offset + 32) * 2) + word(0) + data.slice((offset + 64) * 2);
  assert.equal(decode(nested, broken, 2052).args, null);
});

test("bytes and UTF-8 strings preserve content and reject truncated, dirty-padding or invalid UTF-8 tails", () => {
  const bytes = "hasMigrationRun(bytes)";
  assert.deepEqual(decode(bytes, word(32) + word(0), 2064).args, { key: "0x" });
  for (const data of [
    word(32),
    word(32) + word(33) + "00".repeat(32),
    word(32) + word(1) + "ff" + "00".repeat(30) + "01",
  ])
    assert.equal(decode(bytes, data, 2064).args, null);
  const string = "updateSubnetSymbol(uint16,string)";
  const empty = word(19) + word(64) + word(0);
  assert.deepEqual(decode(string, empty, 2051).args, {
    netuid: 19,
    symbol: "",
  });
  assert.equal(
    decode(string, word(19) + word(64) + word(1) + "ff" + "00".repeat(31), 2051)
      .args,
    null,
  );
  // A failed string decode cannot poison the next request's decoder state.
  const bom = word(19) + word(64) + word(3) + "efbbbf" + "00".repeat(29);
  assert.deepEqual(decode(string, bom, 2051).args, {
    netuid: 19,
    symbol: "\ufeff",
  });
});
