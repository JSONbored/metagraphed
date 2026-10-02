import assert from "node:assert/strict";
import { test } from "vitest";
import { nativeContractEdgeFixture } from "./fixtures/native-contract-edge.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import {
  nativeContractSimulationWork,
  assertNativeContractSimulationBudget,
} from "../src/native-contract-simulation.ts";
import type { NativeValue } from "../src/native-runtime-values.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

// Source-derived API and result families, independently SCALE-encoded. These
// fixtures do not execute Wasm or observe deployed-chain capacity/latency.
// https://github.com/RaoFoundation/subtensor/blob/923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d/runtime/src/lib.rs
// https://github.com/RaoFoundation/polkadot-sdk/blob/cacb4310f20c7cac83eb3ccd8ed5a5ad4212608a/substrate/frame/contracts/src/primitives.rs
const origin = `0x${"11".repeat(32)}`,
  dest = `0x${"22".repeat(32)}`;
const hash = `0x${"33".repeat(32)}`,
  genesis = `0x${"44".repeat(32)}`;
const none = { variant: "None", fields: {} };
const someWeight = (
  ref_time: NativeValue = "100000000000",
  proof_size: NativeValue = "32768",
) => ({
  variant: "Some",
  fields: { ref_time, proof_size },
});
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
const composite = (id: number, fields: [string | null, number][]) =>
  type(id, {
    composite: { fields: fields.map(([name, inner]) => field(name, inner)) },
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
const option = (id: number, inner: number) =>
  variants(id, [
    ["None", 0, null],
    ["Some", 1, inner],
  ]);
const portable = [
  type(7, { array: { len: 32, type: 0 } }),
  type(8, { sequence: { type: 0 } }),
  type(9, { primitive: "U64" }),
  type(10, { compact: { type: 9 } }),
  composite(11, [
    ["ref_time", 10],
    ["proof_size", 10],
  ]),
  option(12, 11),
  option(13, 9),
  variants(14, [
    ["Upload", 0, 8],
    ["Existing", 1, 7],
  ]),
  variants(15, [
    ["Enforced", 0, null],
    ["Relaxed", 1, null],
  ]),
  type(16, { primitive: "U32" }),
  composite(17, [[null, 16]]),
  composite(18, [
    ["flags", 17],
    ["data", 8],
  ]),
  type(19, { array: { len: 4, type: 0 } }),
  composite(20, [
    ["index", 0],
    ["error", 19],
  ]),
  variants(21, [
    ["Other", 0, null],
    ["BadOrigin", 2, null],
    ["Module", 3, 20],
  ]),
  variants(22, [
    ["Ok", 0, 18],
    ["Err", 1, 21],
  ]),
  variants(23, [
    ["Refund", 0, 9],
    ["Charge", 1, 9],
  ]),
  type(24, { sequence: { type: 0 } }),
  option(25, 24),
  composite(26, [
    ["gas_consumed", 11],
    ["gas_required", 11],
    ["storage_deposit", 23],
    ["debug_message", 8],
    ["result", 22],
    ["events", 25],
  ]),
  composite(27, [
    ["result", 18],
    ["account_id", 7],
  ]),
  variants(28, [
    ["Ok", 0, 27],
    ["Err", 1, 21],
  ]),
  composite(29, [
    ["gas_consumed", 11],
    ["gas_required", 11],
    ["storage_deposit", 23],
    ["debug_message", 8],
    ["result", 28],
    ["events", 25],
  ]),
  composite(30, [
    ["code_hash", 7],
    ["deposit", 9],
  ]),
  variants(31, [
    ["Ok", 0, 30],
    ["Err", 1, 21],
  ]),
];
const methods = [
  {
    name: "call",
    inputs: [
      ["origin", 7],
      ["dest", 7],
      ["value", 9],
      ["gas_limit", 12],
      ["storage_deposit_limit", 13],
      ["input_data", 8],
    ],
    output: 26,
  },
  {
    name: "instantiate",
    inputs: [
      ["origin", 7],
      ["value", 9],
      ["gas_limit", 12],
      ["storage_deposit_limit", 13],
      ["code", 14],
      ["data", 8],
      ["salt", 8],
    ],
    output: 29,
  },
  {
    name: "upload_code",
    inputs: [
      ["origin", 7],
      ["code", 8],
      ["storage_deposit_limit", 13],
      ["determinism", 15],
    ],
    output: 31,
  },
] as const;
function fixture() {
  const { wrapped, registry } = nativeContractEdgeFixture(
    false,
    [
      {
        name: "ContractsApi",
        docs: [],
        methods: methods.map((row) => ({
          ...row,
          docs: [],
          inputs: row.inputs.map(([name, type]) => ({ name, type })),
        })),
      },
    ],
    portable,
  );
  registry.register({
    FixtureContractWeight: {
      ref_time: "Compact<u64>",
      proof_size: "Compact<u64>",
    },
    FixtureContractExec: { flags: "u32", data: "Bytes" },
    FixtureContractModuleError: { index: "u8", error: "[u8;4]" },
    FixtureContractDispatchError: {
      _enum: {
        Other: "Null",
        CannotLookup: "Null",
        BadOrigin: "Null",
        Module: "FixtureContractModuleError",
      },
    },
    FixtureContractExecResult: {
      _enum: { Ok: "FixtureContractExec", Err: "FixtureContractDispatchError" },
    },
    FixtureContractDeposit: { _enum: { Refund: "u64", Charge: "u64" } },
    FixtureContractResult: {
      gas_consumed: "FixtureContractWeight",
      gas_required: "FixtureContractWeight",
      storage_deposit: "FixtureContractDeposit",
      debug_message: "Bytes",
      result: "FixtureContractExecResult",
      events: "Option<Vec<u8>>",
    },
    FixtureContractInstantiate: {
      result: "FixtureContractExec",
      account_id: "AccountId32",
    },
    FixtureContractInstantiateResult: {
      _enum: {
        Ok: "FixtureContractInstantiate",
        Err: "FixtureContractDispatchError",
      },
    },
    FixtureContractCreation: {
      gas_consumed: "FixtureContractWeight",
      gas_required: "FixtureContractWeight",
      storage_deposit: "FixtureContractDeposit",
      debug_message: "Bytes",
      result: "FixtureContractInstantiateResult",
      events: "Option<Vec<u8>>",
    },
    FixtureContractCode: { _enum: { Upload: "Bytes", Existing: "H256" } },
    FixtureContractDeterminism: { _enum: ["Enforced", "Relaxed"] },
    FixtureContractUpload: { code_hash: "H256", deposit: "u64" },
    FixtureContractUploadResult: {
      _enum: {
        Ok: "FixtureContractUpload",
        Err: "FixtureContractDispatchError",
      },
    },
  });
  const base = {
    gas_consumed: { ref_time: 500, proof_size: 100 },
    gas_required: { ref_time: 600, proof_size: 120 },
    storage_deposit: { Charge: "9007199254740993" },
    debug_message: "0x",
    events: null,
  };
  const outputs = new Map([
    [
      "call",
      registry
        .createType("FixtureContractResult", {
          ...base,
          result: { Ok: { flags: 1, data: "0xdeadbeef" } },
        })
        .toHex(),
    ],
    [
      "instantiate",
      registry
        .createType("FixtureContractCreation", {
          ...base,
          result: {
            Ok: { result: { flags: 0, data: "0x0102" }, account_id: dest },
          },
        })
        .toHex(),
    ],
    [
      "upload_code",
      registry
        .createType("FixtureContractUploadResult", {
          Ok: { code_hash: hash, deposit: "9007199254740993" },
        })
        .toHex(),
    ],
  ]);
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "state_call") {
      if (params[0] === "Metadata_metadata_at_version") return wrapped;
      const output = outputs.get(
        String(params[0]).replace("ContractsApi_", ""),
      );
      assert.ok(output, `Unexpected execution ${params[0]}`);
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
  return { rpc, registry, calls, outputs, base };
}
const callArgs = (gas: NativeValue = someWeight()): NativeValue[] => [
  origin,
  dest,
  "9007199254740993",
  gas,
  none,
  "0xdead",
];
const instantiateArgs = (
  code: NativeValue = { variant: "Existing", fields: hash },
): NativeValue[] => [origin, "0", someWeight(), none, code, "0x0102", "0x0304"];
const uploadArgs = (
  code: NativeValue = "0x0061736d01000000",
): NativeValue[] => [origin, code, none, { variant: "Enforced", fields: {} }];
const operation = (member = "call", args = callArgs()) => ({
  kind: "runtime",
  api: "ContractsApi",
  member,
  args,
});

test("contract calls retain reverted bytes, exact deposits and compact Weight at a finalized source", async () => {
  const f = fixture();
  const out = await queryNativeRuntime({ operations: [operation()] }, f.rpc);
  const expected = f.registry
    .createType(
      "(AccountId32,AccountId32,u64,Option<FixtureContractWeight>,Option<u64>,Bytes)",
      [
        origin,
        dest,
        "9007199254740993",
        { ref_time: "100000000000", proof_size: "32768" },
        null,
        "0xdead",
      ],
    )
    .toHex();
  assert.deepEqual(
    f.calls.find((row) => row.params[0] === "ContractsApi_call"),
    { method: "state_call", params: ["ContractsApi_call", expected, hash] },
  );
  assert.deepEqual(out.results[0]!.value, {
    gas_consumed: { ref_time: "500", proof_size: "100" },
    gas_required: { ref_time: "600", proof_size: "120" },
    storage_deposit: { variant: "Charge", fields: "9007199254740993" },
    debug_message: "0x",
    result: { variant: "Ok", fields: { flags: "1", data: "0xdeadbeef" } },
    events: none,
  });
  assert.equal(out.source.finalized_block_hash, hash);
  assert.ok(f.calls.every((row) => !row.method.startsWith("author_")));
  assert.ok(out.types.some((row) => row.id === 26));
});
test("instantiate and upload_code use the independently encoded API and preserve their simulated outcomes", async () => {
  for (const code of [
    { variant: "Existing", fields: hash },
    { variant: "Upload", fields: "0x0061736d01000000" },
  ]) {
    const f = fixture();
    const out = await queryNativeRuntime(
      { operations: [operation("instantiate", instantiateArgs(code))] },
      f.rpc,
    );
    const expected = f.registry
      .createType(
        "(AccountId32,u64,Option<FixtureContractWeight>,Option<u64>,FixtureContractCode,Bytes,Bytes)",
        [
          origin,
          0,
          { ref_time: "100000000000", proof_size: "32768" },
          null,
          { [code.variant]: code.fields },
          "0x0102",
          "0x0304",
        ],
      )
      .toHex();
    assert.deepEqual(
      f.calls.find((row) => row.params[0] === "ContractsApi_instantiate")!
        .params,
      ["ContractsApi_instantiate", expected, hash],
    );
    assert.match(JSON.stringify(out.results[0]!.value), new RegExp(dest));
  }
  const f = fixture();
  const out = await queryNativeRuntime(
    { operations: [operation("upload_code", uploadArgs())] },
    f.rpc,
  );
  const expected = f.registry
    .createType("(AccountId32,Bytes,Option<u64>,FixtureContractDeterminism)", [
      origin,
      "0x0061736d01000000",
      null,
      "Enforced",
    ])
    .toHex();
  assert.deepEqual(
    f.calls.find((row) => row.params[0] === "ContractsApi_upload_code")!.params,
    ["ContractsApi_upload_code", expected, hash],
  );
  assert.deepEqual(out.results[0]!.value, {
    variant: "Ok",
    fields: { code_hash: hash, deposit: "9007199254740993" },
  });
  f.outputs.set(
    "upload_code",
    f.registry
      .createType("FixtureContractUploadResult", {
        Err: { Module: { index: 29, error: "0x01000000" } },
      })
      .toHex(),
  );
  assert.deepEqual(
    (
      await queryNativeRuntime(
        { operations: [operation("upload_code", uploadArgs())] },
        f.rpc,
      )
    ).results[0]!.value,
    {
      variant: "Err",
      fields: {
        variant: "Module",
        fields: { index: "29", error: "0x01000000" },
      },
    },
  );
  f.outputs.set(
    "call",
    f.registry
      .createType("FixtureContractResult", {
        ...f.base,
        storage_deposit: { Refund: 1 },
        result: { Err: "BadOrigin" },
      })
      .toHex(),
  );
  const failure = (
    await queryNativeRuntime({ operations: [operation()] }, f.rpc)
  ).results[0]!.value;
  assert.match(JSON.stringify(failure), /Refund.*BadOrigin/);
});
test("unbounded and oversized contracts never reach an execution RPC", async () => {
  for (const gas of [
    none,
    someWeight("0"),
    someWeight("250000000001"),
    someWeight("1", "65537"),
    someWeight("01"),
    someWeight(-1),
    someWeight(9007199254740992),
  ]) {
    const f = fixture();
    await assert.rejects(
      queryNativeRuntime(
        { operations: [operation("call", callArgs(gas))] },
        f.rpc,
      ),
    );
    assert.ok(!f.calls.some((row) => row.params[0] === "ContractsApi_call"));
  }
  for (const row of [
    operation("upload_code", uploadArgs(`0x${"00".repeat(16385)}`)),
    operation(
      "instantiate",
      instantiateArgs({ variant: "Upload", fields: `0x${"00".repeat(16385)}` }),
    ),
  ]) {
    const f = fixture();
    await assert.rejects(
      queryNativeRuntime({ operations: [row] }, f.rpc),
      /byte budget/,
    );
    assert.ok(
      !f.calls.some((call) =>
        String(call.params[0]).startsWith("ContractsApi_"),
      ),
    );
  }
});
test("aggregate limits apply to distinct contract execution, while duplicates share one read", async () => {
  for (const [left, right] of [
    [
      callArgs(someWeight("150000000000", "0")),
      callArgs(someWeight("150000000000", "1")),
    ],
    [callArgs(someWeight("1", "40000")), callArgs(someWeight("2", "40000"))],
  ]) {
    const f = fixture();
    await assert.rejects(
      queryNativeRuntime(
        { operations: [operation("call", left), operation("call", right)] },
        f.rpc,
      ),
      /aggregate Weight or code/,
    );
    assert.ok(!f.calls.some((row) => row.params[0] === "ContractsApi_call"));
  }
  const f = fixture();
  const max = operation("call", callArgs(someWeight("250000000000", "65536")));
  const out = await queryNativeRuntime({ operations: [max, max] }, f.rpc);
  assert.deepEqual(out.results[0], out.results[1]);
  assert.equal(
    f.calls.filter((row) => row.params[0] === "ContractsApi_call").length,
    1,
  );
  const twoCodes = fixture();
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          operation("upload_code", uploadArgs()),
          operation(
            "instantiate",
            instantiateArgs({ variant: "Upload", fields: "0x00" }),
          ),
        ],
      },
      twoCodes.rpc,
    ),
    /aggregate Weight or code/,
  );
  assert.ok(
    !twoCodes.calls.some((row) =>
      String(row.params[0]).startsWith("ContractsApi_"),
    ),
  );
  const oneCode = fixture();
  const upload = operation("upload_code", uploadArgs());
  await queryNativeRuntime({ operations: [upload, upload] }, oneCode.rpc);
  assert.equal(
    oneCode.calls.filter((row) => row.params[0] === "ContractsApi_upload_code")
      .length,
    1,
  );
});
test("contract discovery exposes simulation methods with their runtime portable types", async () => {
  const f = fixture();
  const out = await queryNativeRuntime(
    { operations: [{ kind: "describe", api: "ContractsApi" }] },
    f.rpc,
  );
  assert.deepEqual(
    (out.results[0]!.value as { member: string }[]).map((row) => row.member),
    ["call", "instantiate", "upload_code"],
  );
  assert.ok(out.types.some((row) => row.id === 12));
  assert.ok(
    !f.calls.some((row) => String(row.params[0]).startsWith("ContractsApi_")),
  );
});
test("WeightV1, byte arrays and ambiguous metadata cannot bypass contract work admission", () => {
  const inputs = [{ name: "gas_limit" }, { name: "code" }];
  assert.deepEqual(
    nativeContractSimulationWork("call", inputs, [
      { variant: "Some", fields: 1 },
      "0x",
    ]),
    { refTime: 1n, proofSize: 0n, codeBytes: 0, codeUploads: 0 },
  );
  assert.equal(
    nativeContractSimulationWork("upload_code", inputs, [
      none,
      [0, 97, 115, 109],
    ]).codeBytes,
    4,
  );
  for (const names of [[], [{ name: "gas_limit" }, { name: "gas_limit" }]])
    assert.throws(
      () =>
        nativeContractSimulationWork("call", names, [
          someWeight(),
          someWeight(),
        ]),
      /declared gas_limit/,
    );
  assert.throws(
    () => nativeContractSimulationWork("call", inputs, [none, "0x"]),
    /explicit exact gas_limit/,
  );
  assert.throws(() =>
    nativeContractSimulationWork("instantiate", inputs, [
      someWeight(),
      { variant: "Other", fields: {} },
    ]),
  );
  assert.throws(() =>
    nativeContractSimulationWork("upload_code", inputs, [none, [256]]),
  );
  const huge = `0x${"00".repeat(16385)}`;
  assert.throws(
    () => nativeContractSimulationWork("upload_code", inputs, [none, huge]),
    /code byte budget/,
  );
  assert.throws(
    () =>
      assertNativeContractSimulationBudget([
        { refTime: 0n, proofSize: 0n, codeBytes: 16385, codeUploads: 0 },
      ]),
    /aggregate/,
  );
  assertNativeContractSimulationBudget([]);
});
