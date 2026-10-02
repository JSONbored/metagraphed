import assert from "node:assert/strict";
import { test } from "vitest";
import { describeRuntimeEvm, encodeRuntimeEvmCall } from "../src/evm-runtime-abi.ts";
import { decodeRuntimeEvmCall } from "../src/evm-runtime-calldata.ts";
import { evmRuntimeCatalogue as catalogue } from "../src/evm-runtime-catalogue.ts";
import reference from "./fixtures/evm-runtime-reference.ts";

const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
const types = (signature: string) => signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);

test("every published release precompile encodes byte-identical independent ethers vectors", () => {
  let cases = 0;
  for (const release of catalogue.releases) {
    for (const id of release[2]) {
      const precompile = catalogue.precompiles[id];
      for (const fnId of precompile[2]) {
        const fn = catalogue.functions[fnId];
        assert.ok(types(fn[0]).every((type) => /^(?:uint(?:8|16|32|64|128|256)|address|bool|bytes(?:[1-9]|[12]\d|3[0-2])?|string)(?:\[\]){0,2}$/.test(type)), fn[0]);
        const [input, args] = reference.vectors[fnId];
        assert.equal(encodeRuntimeEvmCall(release[0], address(precompile[1]), fn[0], args).input, input);
        cases++;
      }
    }
  }
  const fn = "setWeights(uint16,uint16[],uint16[],uint64)";
  const args = [19, Array.from({length:16},(_,i)=>i), Array(16).fill(65535), "1"];
  const encoded = encodeRuntimeEvmCall(470, address(2052), fn, args);
  console.log("NATIVE_EVM_ABI_FIXTURE", JSON.stringify({ release_reference_cases: cases,
    calldata_hex_bytes: Buffer.byteLength(encoded.input), signature_args_bytes: Buffer.byteLength(JSON.stringify({signature:fn,args})),
    runtime_selector_hashes: 0, additional_chain_requests: 0, fixture: true, production: false }));
});

test("discovery pages only the selected release and precompile, preserving raw precompiles", () => {
  const first = describeRuntimeEvm(470, true, 0, 2);
  assert.equal(first.contract.total, 33);
  assert.equal(first.value.length, 2);
  assert.equal(first.contract.next_offset, 2);
  assert.equal(first.contract.source_commit, "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d");
  assert.equal(describeRuntimeEvm(470, true, 33, 64).value.length, 0);
  assert.equal(describeRuntimeEvm(470, true, 33, 64).contract.next_offset, null);
  const detail = describeRuntimeEvm(470, address(2053), 0, 64);
  assert.ok(detail.value.some((row) => "signature" in row && row.signature === "getStake(bytes32,bytes32,uint256)"));
  assert.equal(describeRuntimeEvm(470, address(1), 0, 64).contract.total, 0);
  for (const spec of [0,436,471]) assert.throws(() => describeRuntimeEvm(spec, true, 0, 64), /not qualified/);
  for (const to of [address(9999), `0x${"ab".repeat(20)}`]) assert.throws(() => describeRuntimeEvm(470, to, 0, 64), /Unknown EVM/);
  assert.throws(() => encodeRuntimeEvmCall(470, address(1), "anything()", []), /Unknown EVM signature/);
  assert.throws(() => encodeRuntimeEvmCall(470, address(2053), "missing()", []), /Unknown EVM signature/);
});

function argumentCase(type: string) {
  const release = catalogue.releases.find((row) => row[0] === 470)!;
  for (const id of release[2]) {
    const precompile = catalogue.precompiles[id];
    for (const fnId of precompile[2]) {
      const fn = catalogue.functions[fnId];
      const index = types(fn[0]).indexOf(type);
      if (index >= 0) return { to:address(precompile[1]), signature:fn[0], index, args:reference.vectors[fnId][1].slice() };
    }
  }
  throw new Error(`Missing test ABI ${type}`);
}
test("integer widths, exact quantities, byte padding, UTF-8 and nested arrays reject invalid inputs before allocation", () => {
  const invalid: [string, unknown, RegExp][] = [
    ["uint256", "1".repeat(79), /exact/], ["uint256", "-1", /exact/],
    ["uint256", 1.5, /exact/], ["uint256", Number.MAX_SAFE_INTEGER + 1, /exact/],
    ["uint256", -1, /exact/], ["uint256", null, /exact/],
    ["uint256", (1n << 256n).toString(), /width/], ["uint16", 65536, /width/],
    ["bool", 1, /boolean/], ["address", "0x12", /20-byte/],
    ["bytes32", `0x${"11".repeat(31)}`, /length/], ["bytes32", null, /length/],
    ["bytes", "0x1", /even-length/], ["bytes", 1, /string/],
    ["string", "\ud800", /surrogate/], ["string", "\udc00", /surrogate/],
    ["bytes", `0x${"ab".repeat(32768)}`, /byte budget/],
    ["uint16[]", null, /array/], ["uint16[]", Array(4097).fill(0), /work budget/],
    ["uint16[]", Array(1024).fill(0), /byte budget/], ["uint16[][]", [0], /array/],
  ];
  for (const [type, value, error] of invalid) {
    const c = argumentCase(type); c.args[c.index] = value;
    assert.throws(() => encodeRuntimeEvmCall(470,c.to,c.signature,c.args),error,`${type} ${String(value).slice(0,40)}`);
  }
  const c = argumentCase("uint256");
  assert.throws(() => encodeRuntimeEvmCall(470,c.to,c.signature,[]), /arity/);
  c.args[c.index] = "0";
  assert.ok(encodeRuntimeEvmCall(470,c.to,c.signature,c.args).input.endsWith("0".repeat(64)));
  for (const [type, value] of [["bool",false],["uint256",(1n<<256n)-1n],["bytes","0x"],["string","\ufeff🦀"],["uint16[]",[]],["uint16[][]",[[],[0,65535]]]] as const) {
    const c = argumentCase(type);
    c.args[c.index] = typeof value === "bigint" ? value.toString() : value;
    const encoded = encodeRuntimeEvmCall(470,c.to,c.signature,c.args);
    assert.notEqual(decodeRuntimeEvmCall(470,c.to,encoded.input)!.args,null);
  }
});
