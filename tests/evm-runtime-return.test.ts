import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { decodeNativeEvmResult } from "../src/evm-runtime-return.ts";
import {
  evmRuntimeOutputs,
  type RuntimeEvmOutput,
} from "../src/evm-runtime-outputs.ts";
import { evmRuntimeCatalogue } from "../src/evm-runtime-catalogue.ts";
import {
  encodeRuntimeEvmCall,
  describeRuntimeEvm,
} from "../src/evm-runtime-abi.ts";
import { NativeEvmResultSchema } from "../schemas-src/routes/native-runtime.ts";
import reference from "./fixtures/evm-runtime-output-reference.ts";
import inputs from "./fixtures/evm-runtime-reference.ts";
import type { NativeValue } from "../src/native-runtime-values.ts";

const success = (value: string): NativeValue => ({
  variant: "Ok",
  fields: {
    exit_reason: {
      variant: "Succeed",
      fields: { variant: "Returned", fields: {} },
    },
    value,
  },
});
const word = (value: number | bigint) =>
  BigInt(value).toString(16).padStart(64, "0");
const decoded = (params: RuntimeEvmOutput[], value: string) =>
  decodeNativeEvmResult(success(value), params);

test("all release-qualified precompile outputs decode independent official ethers return vectors with exact values", () => {
  assert.equal(reference.reference.version, "ethers@6.15.0");
  assert.equal(reference.vectors.length, evmRuntimeOutputs.outputs.length);
  assert.equal(evmRuntimeOutputs.releases.length, 91);
  let cases = 0;
  for (const release of evmRuntimeOutputs.releases) {
    const source = evmRuntimeCatalogue.releases.find(
      (row) => row[0] === release[0],
    )!;
    assert.equal(source[1], release[1]);
    assert.deepEqual(
      release[2].map((id) => evmRuntimeOutputs.bindings[id][0]),
      source[2].filter((id) => evmRuntimeCatalogue.precompiles[id][2].length),
    );
    const manifest = reference.manifests.find(
      (row) => row.spec === release[0],
    )!;
    assert.ok(manifest.files.every((row) => /^[0-9a-f]{64}$/.test(row[1])));
    let functions = 0;
    for (const id of release[2]) {
      const binding = evmRuntimeOutputs.bindings[id],
        precompile = evmRuntimeCatalogue.precompiles[binding[0]];
      assert.deepEqual(
        binding[1].map((row) => row[0]),
        precompile[2],
      );
      const to = `0x${precompile[1].toString(16).padStart(40, "0")}`;
      for (const [fnId, outputId] of binding[1]) {
        const fn = evmRuntimeCatalogue.functions[fnId],
          output = evmRuntimeOutputs.outputs[outputId],
          vector = reference.vectors[outputId];
        const result = decoded(output, vector[0]);
        assert.deepEqual(
          result,
          { status: "decoded", values: vector[1] },
          `${release[0]} ${precompile[0]} ${fn[0]}`,
        );
        NativeEvmResultSchema.parse(result);
        assert.deepEqual(
          encodeRuntimeEvmCall(release[0], to, fn[0], inputs.vectors[fnId][1])
            .outputs,
          output,
        );
        const discovery = describeRuntimeEvm(
          release[0],
          to,
          precompile[2].indexOf(fnId),
          1,
        ).value[0];
        assert.ok("outputs" in discovery);
        assert.deepEqual(discovery.outputs, output);
        cases++;
        functions++;
      }
    }
    assert.equal(functions, manifest.functions);
  }
  const repeated = JSON.stringify(
    evmRuntimeOutputs.releases.map((release) => [
      release[0],
      release[1],
      release[2].map((id) => {
        const binding = evmRuntimeOutputs.bindings[id];
        return [
          binding[0],
          binding[1].map(([fn, output]) => [
            fn,
            evmRuntimeOutputs.outputs[output],
          ]),
        ];
      }),
    ]),
  );
  console.log(
    "NATIVE_EVM_RETURN_FIXTURE",
    JSON.stringify({
      release_reference_cases: cases,
      shared_output_catalogue_bytes: Buffer.byteLength(
        JSON.stringify(evmRuntimeOutputs),
      ),
      repeated_output_catalogue_bytes: Buffer.byteLength(repeated),
      additional_chain_requests: 0,
      fixture: true,
      production: false,
    }),
  );
});

test("malformed ABI return bytes never become successful values and never discard the native result", () => {
  const scalar = (type: string): RuntimeEvmOutput[] => [{ name: "", type }];
  const invalid: [RuntimeEvmOutput[], string][] = [
    [scalar("uint256"), "nothex"],
    [scalar("uint256"), "0x1"],
    [scalar("uint256"), `0x${"00".repeat(262145)}`],
    [scalar("uint256"), "0x"],
    [scalar("uint256"), `0x${word(1)}00`],
    [scalar("uint8"), `0x${word(256)}`],
    [scalar("bool"), `0x${word(2)}`],
    [scalar("address"), `0x${word(1n << 160n)}`],
    [scalar("bytes4"), `0x${word(1)}`],
    [scalar("bytes"), `0x${word(64)}${word(0)}`],
    [scalar("bytes"), `0x${word(1n << 255n)}`],
    [scalar("bytes"), `0x${word(32)}`],
    [scalar("bytes"), `0x${word(32)}${word(33)}`],
    [scalar("bytes"), `0x${word(32)}${word(1)}${"ab".repeat(32)}`],
    [scalar("string"), `0x${word(32)}${word(1)}ff${"00".repeat(31)}`],
    [scalar("uint64[]"), `0x${word(32)}${word(2)}${word(1)}`],
    [scalar("uint64[]"), `0x${word(32)}${word(16384)}${word(0).repeat(16382)}`],
    [scalar("uint8[16384]"), "0x"],
    [[{ name: "", type: "tuple[16384]", components: [] }], "0x"],
    [
      [
        {
          name: "",
          type: "tuple[16383]",
          components: [{ name: "a", type: "tuple", components: [] }],
        },
      ],
      "0x",
    ],
  ];
  for (const [params, data] of invalid) {
    const value = success(data),
      copy = structuredClone(value);
    assert.deepEqual(decodeNativeEvmResult(value, params), {
      status: "invalid_output",
    });
    assert.deepEqual(value, copy);
  }
  assert.deepEqual(decoded([], "0x"), { status: "decoded", values: [] });
  assert.deepEqual(decoded(scalar("bytes"), `0x${word(32)}${word(0)}`), {
    status: "decoded",
    values: ["0x"],
  });
  assert.deepEqual(decoded(scalar("bool"), `0x${word(0)}`), {
    status: "decoded",
    values: [false],
  });
  assert.deepEqual(decoded(scalar("bytes4"), `0x12345678${"00".repeat(28)}`), {
    status: "decoded",
    values: ["0x12345678"],
  });
  assert.deepEqual(decoded(scalar("uint16[]"), `0x${word(32)}${word(0)}`), {
    status: "decoded",
    values: [[]],
  });
  const tuple: RuntimeEvmOutput[] = [
    {
      name: "",
      type: "tuple",
      components: [
        { name: "a", type: "uint64" },
        { name: "b", type: "bytes" },
      ],
    },
  ];
  assert.deepEqual(
    decoded(
      tuple,
      `0x${word(32)}${word(9007199254740993n)}${word(64)}${word(0)}`,
    ),
    { status: "decoded", values: [{ a: "9007199254740993", b: "0x" }] },
  );
  assert.deepEqual(
    decoded(
      [{ name: "", type: "tuple", components: [{ name: "", type: "uint8" }] }],
      `0x${word(1)}`,
    ),
    { status: "decoded", values: [[1]] },
  );
  assert.deepEqual(
    decoded(
      [
        {
          name: "",
          type: "tuple",
          components: [
            { name: "a", type: "uint8" },
            { name: "a", type: "uint8" },
          ],
        },
      ],
      `0x${word(1)}${word(2)}`,
    ),
    { status: "decoded", values: [[1, 2]] },
  );
  assert.deepEqual(decoded(scalar("uint16[2]"), `0x${word(1)}${word(2)}`), {
    status: "decoded",
    values: [[1, 2]],
  });
  let recursive: RuntimeEvmOutput = { name: "", type: "uint8" };
  for (let depth = 0; depth < 65; depth++)
    recursive = { name: "", type: "tuple", components: [recursive] };
  assert.deepEqual(decoded([recursive], `0x${word(0)}`), {
    status: "invalid_output",
  });
});

test("dispatch errors, all EVM failure exits and future result layouts retain explicit status without return decoding", () => {
  const output: RuntimeEvmOutput[] = [{ name: "", type: "uint256" }];
  for (const value of [
    null,
    [],
    { variant: "Ok", fields: 0 },
    { variant: "Future", fields: {} },
    { variant: "Ok", fields: { exit_reason: 0 } },
    { variant: "Ok", fields: { exit_reason: { variant: "Future" } } },
    {
      variant: "Ok",
      fields: { exit_reason: { variant: "Succeed" }, value: [] },
    },
  ] as NativeValue[]) {
    assert.deepEqual(decodeNativeEvmResult(value, output), {
      status: "unrecognized_result",
    });
  }
  assert.deepEqual(
    decodeNativeEvmResult({ variant: "Err", fields: "42" }, output),
    { status: "dispatch_error" },
  );
  for (const variant of ["Revert", "Error", "Fatal"]) {
    const value = {
      variant: "Ok",
      fields: { exit_reason: { variant, fields: {} }, value: "bad" },
    };
    const result = decodeNativeEvmResult(value, output);
    assert.deepEqual(result, {
      status: variant === "Revert" ? "reverted" : "execution_error",
    });
    NativeEvmResultSchema.parse(result);
  }
});

test("large ABI arrays reuse one element type instead of allocating a repeated type vector", () => {
  const count = 500,
    OriginalArray = Array;
  const args = [
    19,
    OriginalArray.from({ length: count }, (_, index) => index),
    OriginalArray(count).fill(65535),
    "1",
  ];
  const signature = "setWeights(uint16,uint16[],uint16[],uint64)",
    to = `0x${(2052).toString(16).padStart(40, "0")}`;
  const returnData = `0x${word(32)}${word(count)}${word(18446744073709551615n).repeat(count)}`;
  let repeatedVectorAllocations = 0;
  vi.stubGlobal(
    "Array",
    new Proxy(OriginalArray, {
      apply(target, receiver, values) {
        if (
          values.length === 1 &&
          typeof values[0] === "number" &&
          values[0] > 1
        )
          repeatedVectorAllocations++;
        return Reflect.apply(target, receiver, values);
      },
    }),
  );
  let encoded: ReturnType<typeof encodeRuntimeEvmCall>,
    result: ReturnType<typeof decodeNativeEvmResult>;
  try {
    encoded = encodeRuntimeEvmCall(470, to, signature, args);
    result = decoded([{ name: "", type: "uint64[]" }], returnData);
  } finally {
    vi.unstubAllGlobals();
  }
  assert.equal(repeatedVectorAllocations, 0);
  const independent =
    encoded.selector +
    word(19) +
    word(128) +
    word(128 + (count + 1) * 32) +
    word(1) +
    word(count) +
    OriginalArray.from({ length: count }, (_, index) => word(index)).join("") +
    word(count) +
    word(65535).repeat(count);
  assert.equal(encoded.input, independent);
  assert.deepEqual(result, {
    status: "decoded",
    values: [OriginalArray(count).fill("18446744073709551615")],
  });
  console.log(
    "NATIVE_EVM_REPEATED_TYPE_FIXTURE",
    JSON.stringify({
      array_items: count,
      arrays: 3,
      previous_repeated_type_slots: count * 3,
      current_type_slots: 3,
      removed_type_slots: (count - 1) * 3,
      repeated_vector_allocations: repeatedVectorAllocations,
      exact_bytes: true,
      fixture: true,
      production: false,
    }),
  );
});
