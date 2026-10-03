import assert from "node:assert/strict";
import { test } from "vitest";
import { nativeContractEdgeFixture } from "./fixtures/native-contract-edge.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

// Source-derived EVM argument families and ExecutionInfoV2 fields, encoded by
// @polkadot/types independently. These are fixtures, not captured chain state.
// https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/vendor/frontier/primitives/rpc/src/lib.rs
// https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/vendor/frontier/primitives/evm/src/lib.rs
const from = `0x${"11".repeat(20)}`,
  to = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`,
  genesis = `0x${"44".repeat(32)}`;
const none = { variant: "None", fields: {} };
const field = (name: string | null, type: number) => ({
  name,
  type,
  typeName: null,
  docs: [],
});
const type = (id: number, def: unknown) => ({
  id,
  type: { path: [], params: [], def, docs: [] },
});
const option = (id: number, inner: number) =>
  type(id, {
    variant: {
      variants: [
        { name: "None", index: 0, fields: [], docs: [] },
        { name: "Some", index: 1, fields: [field(null, inner)], docs: [] },
      ],
    },
  });
const variants = (id: number, rows: [string, number, number | null][]) =>
  type(id, {
    variant: {
      variants: rows.map(([name, index, inner]) => ({
        name,
        index,
        fields: inner === null ? [] : [field(null, inner)],
        docs: [],
      })),
    },
  });
const composite = (id: number, fields: [string | null, number][]) =>
  type(id, {
    composite: { fields: fields.map(([name, inner]) => field(name, inner)) },
  });
const evmTypes = [
  type(7, { array: { len: 20, type: 0 } }),
  type(8, { sequence: { type: 0 } }),
  type(9, { primitive: "Bool" }),
  option(10, 1),
  type(11, { array: { len: 32, type: 0 } }),
  type(12, { sequence: { type: 11 } }),
  type(13, { tuple: [7, 12] }),
  type(14, { sequence: { type: 13 } }),
  option(15, 14),
  type(16, { primitive: "U64" }),
  option(17, 16),
  composite(18, [
    ["ref_time_limit", 17],
    ["proof_size_limit", 17],
    ["ref_time_usage", 17],
    ["proof_size_usage", 17],
  ]),
  option(19, 18),
  composite(20, [
    ["address", 7],
    ["topics", 12],
    ["data", 8],
  ]),
  type(21, { sequence: { type: 20 } }),
  variants(22, [["Returned", 1, null]]),
  variants(23, [["Reverted", 0, null]]),
  variants(24, [
    ["Succeed", 0, 22],
    ["Revert", 2, 23],
  ]),
  composite(25, [
    ["standard", 1],
    ["effective", 1],
  ]),
  composite(26, [
    ["exit_reason", 24],
    ["value", 8],
    ["used_gas", 25],
    ["weight_info", 19],
    ["logs", 21],
  ]),
  composite(27, [
    ["exit_reason", 24],
    ["value", 7],
    ["used_gas", 25],
    ["weight_info", 19],
    ["logs", 21],
  ]),
  variants(28, [
    ["Ok", 0, 26],
    ["Err", 1, 0],
  ]),
  variants(29, [
    ["Ok", 0, 27],
    ["Err", 1, 0],
  ]),
];
const callInputs = [
  ["from", 7],
  ["to", 7],
  ["data", 8],
  ["value", 1],
  ["gas_limit", 1],
  ["max_fee_per_gas", 10],
  ["max_priority_fee_per_gas", 10],
  ["nonce", 10],
  ["estimate", 9],
  ["access_list", 15],
] as const;
function fixture(gasFields?: string[], limbGas = false) {
  const inputs = callInputs.map(([name, type]) => ({
    name,
    type: limbGas && name === "gas_limit" ? 30 : type,
  }));
  if (gasFields)
    inputs.forEach((input, index) => {
      input.name = gasFields[index] as typeof input.name;
    });
  const createInputs = inputs.filter((input) => input.name !== "to");
  const { wrapped, registry } = nativeContractEdgeFixture(
    false,
    [
      {
        name: "EthereumRuntimeRPCApi",
        docs: [],
        methods: [
          { name: "call", inputs, output: 28, docs: [] },
          { name: "create", inputs: createInputs, output: 29, docs: [] },
        ],
      },
    ],
    [
      ...evmTypes,
      composite(30, [[null, 31]]),
      type(31, { array: { len: 4, type: 16 } }),
    ],
  );
  registry.register({
    FixtureExitSucceed: { _enum: { Stopped: "Null", Returned: "Null" } },
    FixtureExitRevert: { _enum: { Reverted: "Null" } },
    FixtureExit: {
      _enum: {
        Succeed: "FixtureExitSucceed",
        Error: "Null",
        Revert: "FixtureExitRevert",
      },
    },
    FixtureUsedGas: { standard: "U256", effective: "U256" },
    FixtureWeight: {
      ref_time_limit: "Option<u64>",
      proof_size_limit: "Option<u64>",
      ref_time_usage: "Option<u64>",
      proof_size_usage: "Option<u64>",
    },
    FixtureLog: { address: "H160", topics: "Vec<H256>", data: "Bytes" },
    FixtureCallInfo: {
      exit_reason: "FixtureExit",
      value: "Bytes",
      used_gas: "FixtureUsedGas",
      weight_info: "Option<FixtureWeight>",
      logs: "Vec<FixtureLog>",
    },
    FixtureCreateInfo: {
      exit_reason: "FixtureExit",
      value: "H160",
      used_gas: "FixtureUsedGas",
      weight_info: "Option<FixtureWeight>",
      logs: "Vec<FixtureLog>",
    },
    FixtureCallResult: { _enum: { Ok: "FixtureCallInfo", Err: "u8" } },
    FixtureCreateResult: { _enum: { Ok: "FixtureCreateInfo", Err: "u8" } },
  });
  const calls: { method: string; params: unknown[] }[] = [];
  let output = registry
    .createType("FixtureCallResult", {
      Ok: {
        exit_reason: { Revert: "Reverted" },
        value: "0xdeadbeef",
        used_gas: { standard: 21000, effective: 22000 },
        weight_info: null,
        logs: [],
      },
    })
    .toHex();
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "state_call") {
      if (params[0] === "Metadata_metadata_at_version") return wrapped;
      return output;
    }
    if (method === "chain_getFinalizedHead") return hash;
    if (method === "chain_getHeader") return { number: "0x1f4" };
    if (method === "chain_getBlockHash")
      return params[0] === 0 ? genesis : hash;
    if (method === "state_getRuntimeVersion")
      return {
        specName: "node-subtensor",
        specVersion: 470,
        transactionVersion: 1,
      };
    if (method === "state_getStorageHash") return null;
    throw new Error(`Unexpected fixture method ${method}`);
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return {
    registry,
    rpc,
    calls,
    setOutput: (value: `0x${string}`) => {
      output = value;
    },
  };
}
const args = (gas: unknown = "500000") => [
  from,
  to,
  "0xdead",
  "9007199254740993",
  gas,
  { variant: "Some", fields: "1" },
  none,
  none,
  false,
  none,
];
const operation = (values = args()) => ({
  kind: "runtime",
  api: "EthereumRuntimeRPCApi",
  member: "call",
  args: values,
});

test("EVM call simulation uses the finalized metadata ABI and retains reverts, bytes and exact gas", async () => {
  const f = fixture();
  const out = await queryNativeRuntime({ operations: [operation()] }, f.rpc);
  const expected = f.registry
    .createType(
      "(H160,H160,Bytes,U256,U256,Option<U256>,Option<U256>,Option<U256>,bool,Option<Vec<(H160,Vec<H256>)>>)",
      [
        from,
        to,
        "0xdead",
        "9007199254740993",
        500000,
        1,
        null,
        null,
        false,
        null,
      ],
    )
    .toHex();
  assert.deepEqual(
    f.calls.find((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    {
      method: "state_call",
      params: ["EthereumRuntimeRPCApi_call", expected, hash],
    },
  );
  assert.deepEqual(out.results[0]!.value, {
    variant: "Ok",
    fields: {
      exit_reason: {
        variant: "Revert",
        fields: { variant: "Reverted", fields: {} },
      },
      value: "0xdeadbeef",
      used_gas: { standard: "21000", effective: "22000" },
      weight_info: none,
      logs: [],
    },
  });
  assert.ok(out.types.some((row) => row.id === 26));
  assert.ok(
    f.calls.every(
      (row) =>
        !row.method.startsWith("author_") && !row.method.startsWith("eth_send"),
    ),
  );
});
test("EVM create simulation and runtime dispatch failures remain typed results", async () => {
  const f = fixture();
  const info = {
    exit_reason: { Succeed: "Returned" },
    value: to,
    used_gas: { standard: 53100, effective: 54000 },
    weight_info: null,
    logs: [],
  };
  f.setOutput(
    f.registry.createType("FixtureCreateResult", { Ok: info }).toHex(),
  );
  const values = args();
  values.splice(1, 1);
  const out = await queryNativeRuntime(
    { operations: [{ ...operation(values), member: "create" }] },
    f.rpc,
  );
  const value = out.results[0]!.value as {
    variant: string;
    fields: { value: string };
  };
  assert.equal(value.variant, "Ok");
  assert.equal(value.fields.value, to);
  const expected = f.registry
    .createType(
      "(H160,Bytes,U256,U256,Option<U256>,Option<U256>,Option<U256>,bool,Option<Vec<(H160,Vec<H256>)>>)",
      [from, "0xdead", "9007199254740993", 500000, 1, null, null, false, null],
    )
    .toHex();
  assert.deepEqual(
    f.calls.find((row) => row.params[0] === "EthereumRuntimeRPCApi_create")!
      .params,
    ["EthereumRuntimeRPCApi_create", expected, hash],
  );
  f.setOutput(f.registry.createType("FixtureCallResult", { Err: 42 }).toHex());
  assert.deepEqual(
    (await queryNativeRuntime({ operations: [operation()] }, f.rpc)).results[0]!
      .value,
    { variant: "Err", fields: "42" },
  );
});
test("simulation gas is exact, positive and bounded before any execution, with an aggregate request cap", async () => {
  for (const gas of [
    "0",
    "1000001",
    "-1",
    "1.5",
    "01",
    true,
    {},
    [],
    -1,
    9007199254740992,
  ]) {
    const f = fixture();
    await assert.rejects(
      queryNativeRuntime({ operations: [operation(args(gas))] }, f.rpc),
      /gas/,
    );
    assert.ok(
      !f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    );
  }
  for (const gas of [1, "1000000"]) {
    const f = fixture();
    await queryNativeRuntime({ operations: [operation(args(gas))] }, f.rpc);
    assert.ok(
      f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    );
  }
  const f = fixture();
  const other = args(600000);
  other[2] = "0xbeef";
  await assert.rejects(
    queryNativeRuntime(
      { operations: [operation(args(600000)), operation(other)] },
      f.rpc,
    ),
    /aggregate gas/,
  );
  assert.ok(
    !f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
  );
  const valid = fixture();
  await queryNativeRuntime(
    { operations: [operation(args("1000000")), operation(args("1000000"))] },
    valid.rpc,
  );
  assert.equal(
    valid.calls.filter((row) => row.params[0] === "EthereumRuntimeRPCApi_call")
      .length,
    1,
  );
});
test("unknown or ambiguous metadata gas names cannot silently bypass the execution bound", async () => {
  for (const names of [
    callInputs.map(([name]) => (name === "gas_limit" ? "other" : name)),
    callInputs.map(([name]) => (name === "value" ? "gas_limit" : name)),
  ]) {
    const f = fixture(names);
    await assert.rejects(
      queryNativeRuntime({ operations: [operation()] }, f.rpc),
      /declared gas_limit/,
    );
    assert.ok(
      !f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    );
  }
});

test("derived U256 gas uses every little-endian u64 limb and the reference ABI without bypassing request bounds", async () => {
  for (const gas of [
    [1, "0", 0, "0"],
    ["1000000", 0, "0", 0],
  ]) {
    const f = fixture(undefined, true);
    const out = await queryNativeRuntime(
      { operations: [operation(args(gas)), operation(args(gas))] },
      f.rpc,
    );
    const expected = f.registry
      .createType(
        "(H160,H160,Bytes,U256,U256,Option<U256>,Option<U256>,Option<U256>,bool,Option<Vec<(H160,Vec<H256>)>>)",
        [
          from,
          to,
          "0xdead",
          "9007199254740993",
          gas[0],
          1,
          null,
          null,
          false,
          null,
        ],
      )
      .toHex();
    const executions = f.calls.filter(
      (row) => row.params[0] === "EthereumRuntimeRPCApi_call",
    );
    assert.deepEqual(executions, [
      {
        method: "state_call",
        params: ["EthereumRuntimeRPCApi_call", expected, hash],
      },
    ]);
    assert.deepEqual(out.results[0], out.results[1]);
  }
  for (const gas of [
    [0, 0, 0, 0],
    ["1000001", 0, 0, 0],
    [1, 1, 0, 0],
    [1, 0, 1, 0],
    [1, 0, 0, 1],
    [1, -1, 0, 0],
    [1, "01", 0, 0],
    [1, "18446744073709551616", 0, 0],
    [1, 9007199254740992, 0, 0],
    [1, 0, 0],
    [1, 0, 0, 0, 0],
    [1, true, 0, 0],
  ]) {
    const f = fixture(undefined, true);
    await assert.rejects(
      queryNativeRuntime({ operations: [operation(args(gas))] }, f.rpc),
      /gas/,
    );
    assert.ok(
      !f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    );
  }
  const f = fixture(undefined, true);
  const other = args(["600000", 0, 0, 0]);
  other[2] = "0xbeef";
  await assert.rejects(
    queryNativeRuntime(
      { operations: [operation(args(["600000", 0, 0, 0])), operation(other)] },
      f.rpc,
    ),
    /aggregate gas/,
  );
  assert.ok(
    !f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
  );
});

test("source-bound precompile results decode successful values while retaining all raw failure and gas fields", async () => {
  const f = fixture();
  const values = args();
  values[1] = `0x${(2053).toString(16).padStart(40, "0")}`;
  values[2] = "0x";
  const evm_call = {
    signature: "getStake(bytes32,bytes32,uint256)",
    args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "19"],
  };
  const operation = {
    kind: "runtime",
    api: "EthereumRuntimeRPCApi",
    member: "call",
    args: values,
    evm_call,
  };
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          { ...operation, value_page: { path: [], offset: 0, limit: 1 } },
        ],
      },
      f.rpc,
    ),
    /paging cannot replace evm_call/,
  );
  assert.equal(
    f.calls.some((row) => row.params[0] === "EthereumRuntimeRPCApi_call"),
    false,
  );
  for (const [reason, data, status] of [
    [
      { Succeed: "Returned" },
      `0x${(1n << 200n).toString(16).padStart(64, "0")}`,
      "decoded",
    ],
    [{ Succeed: "Returned" }, "0xdeadbeef", "invalid_output"],
    [{ Revert: "Reverted" }, "0xdeadbeef", "reverted"],
  ] as const) {
    const info = {
      exit_reason: reason,
      value: data,
      used_gas: { standard: 21000, effective: 22000 },
      weight_info: null,
      logs: [],
    };
    f.setOutput(
      f.registry.createType("FixtureCallResult", { Ok: info }).toHex(),
    );
    const output = await queryNativeRuntime({ operations: [operation] }, f.rpc);
    assert.deepEqual(
      output.results[0]!.evm_result,
      status === "decoded"
        ? { status, values: [(1n << 200n).toString()] }
        : { status },
    );
    const native = output.results[0]!.value as {
      fields: {
        value: string;
        used_gas: { standard: string; effective: string };
      };
    };
    assert.equal(native.fields.value, data);
    assert.deepEqual(native.fields.used_gas, {
      standard: "21000",
      effective: "22000",
    });
  }
  f.setOutput(f.registry.createType("FixtureCallResult", { Err: 42 }).toHex());
  const dispatch = await queryNativeRuntime({ operations: [operation] }, f.rpc);
  assert.deepEqual(dispatch.results[0]!.evm_result, {
    status: "dispatch_error",
  });
  assert.deepEqual(dispatch.results[0]!.value, {
    variant: "Err",
    fields: "42",
  });
});
