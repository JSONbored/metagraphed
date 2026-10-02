import { expect, test } from "vitest";
import {
  describedMembers,
  featureOperations,
  memberOperation,
  supportsNativeCodeArtifact,
  codeArtifactOperation,
  supportsNativeEvmCall,
  evmCallOperation,
  evmPrecompileOperation,
  nativeEvmFunctions,
  nativeTypeLabel,
  nativeValueRows,
  innerRecordOperation,
  supportsLegacyInnerRecord,
  nativePageOffset,
  entryOperation,
  nativePageCursor,
  valuePageOperation,
  nextValuePageOperation,
  type NativeArtifact,
} from "./native-runtime";
import { encodeSs58 } from "./ss58";

const key = `0x${"12".repeat(32)}`;
test("legacy record selection is scoped to compiled eras and read families, preserving omitted flags", () => {
  const member = {
    kind: "runtime" as const,
    api: "DelegateInfoRuntimeApi",
    member: "get_delegate",
    args: [],
  };
  expect(supportsLegacyInnerRecord(210, member)).toBe(true);
  for (const spec of [0, 209, 220, 233, 470])
    expect(supportsLegacyInnerRecord(spec, member)).toBe(false);
  expect(supportsLegacyInnerRecord(210, { ...member, api: "AccountNonceApi" })).toBe(false);
  expect(supportsLegacyInnerRecord(210, { ...member, member: "get_subnet_state" })).toBe(false);
  const operation = memberOperation(member, "[]");
  expect(innerRecordOperation(operation, false)).toBe(operation);
  expect(innerRecordOperation(operation, true)).toEqual({ ...operation, decode_inner: true });
  expect(() => innerRecordOperation({ kind: "constant", pallet: "P", member: "C" }, true)).toThrow(
    /legacy runtime record/,
  );
});

test("native tables show decoded records and original wire bytes together without rounding", () => {
  const view: NativeArtifact = {
    ...artifact,
    results: [
      {
        kind: "runtime",
        api: "DelegateInfoRuntimeApi",
        member: "get_delegate",
        contract: {},
        value: "0x00",
        inner_result: { stake: "9007199254740993", owner: key },
      },
    ],
  };
  const rows = nativeValueRows(view);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "1. DelegateInfoRuntimeApi.get_delegate.inner_result.stake",
        value: "9007199254740993",
      }),
      expect.objectContaining({
        field: "1. DelegateInfoRuntimeApi.get_delegate.inner_result.owner",
        value: key,
      }),
      expect.objectContaining({ field: "1. DelegateInfoRuntimeApi.get_delegate", value: "0x00" }),
    ]),
  );
});
test("legacy read discovery accepts exact SCALE arguments without inventing portable types", () => {
  const member = {
    kind: "runtime_scale" as const,
    api: "AccountNonceApi",
    member: "account_nonce",
    args: [],
    runtimeApiVersion: 1,
  };
  const found = describedMembers({
    ...artifact,
    results: [
      {
        kind: "describe",
        value: [
          { kind: "runtime_scale", api: member.api, member: member.member, runtime_api_version: 1 },
        ],
        contract: {},
      },
    ],
  });
  expect(found).toEqual([member]);
  expect(memberOperation(member, " 0x00ABff ")).toEqual({
    kind: "runtime_scale",
    api: member.api,
    member: member.member,
    input: "0x00abff",
  });
  expect(memberOperation(member, "0x")).toMatchObject({ input: "0x" });
  for (const input of ["[]", "0x1", "0xgg", "0x" + "00".repeat(16384)])
    expect(() => memberOperation(member, input)).toThrow(/SCALE argument bytes/);
  expect(featureOperations("conviction", "19", "", key)).toEqual([
    {
      kind: "runtime",
      api: "StakeInfoRuntimeApi",
      member: "get_hotkey_conviction",
      args: [key, 19],
    },
    {
      kind: "runtime",
      api: "StakeInfoRuntimeApi",
      member: "get_most_convicted_hotkey_on_subnet",
      args: [19],
    },
  ]);
});
const artifact: NativeArtifact = {
  schema_version: 1,
  source: {
    network: "finney",
    network_genesis_hash: key,
    finalized_block_hash: key,
    finalized_block: "500",
    runtime_spec_version: 470,
    runtime_transaction_version: 1,
    runtime_code_hash: null,
    metadata_version: 15,
    metadata_sha256: key,
  },
  types: [
    { id: 0, path: [], definition: { kind: "primitive", primitive: 6 } },
    {
      id: 1,
      path: ["NetUid"],
      definition: { kind: "composite", fields: [{ name: null, type: 0 }] },
    },
    { id: 2, path: [], definition: { kind: "tuple", types: [0, 1] } },
  ],
  results: [],
};
test("new hyperparameter identifiers become readable labels without rounding values or discarding opaque names", () => {
  const value = [
    {
      name: "0x6675747572655f6669656c64",
      value: { variant: "U128", fields: "340282366920938463463374607431768211455" },
    },
    { name: "0xff", value: true },
    { name: "0x00", value: false },
  ];
  const data = {
    ...artifact,
    results: [
      {
        kind: "runtime" as const,
        api: "SubnetInfoRuntimeApi",
        member: "get_subnet_hyperparams_v3",
        contract: {},
        value,
      },
    ],
  };
  const original = JSON.stringify(data);
  const rows = nativeValueRows(data);
  expect(rows).toContainEqual(
    expect.objectContaining({
      field: expect.stringContaining("future_field.fields"),
      value: "340282366920938463463374607431768211455",
    }),
  );
  expect(rows).toContainEqual(expect.objectContaining({ value: "0xff" }));
  expect(rows).toContainEqual(expect.objectContaining({ value: "0x00" }));
  expect(JSON.stringify(data)).toBe(original);
});
test("map browsing accepts leading keys and preserves exact cursor context", () => {
  const member = {
    kind: "storage" as const,
    pallet: "SubtensorModule",
    member: "MinerCollateral",
    args: [
      { name: "netuid", type: 0 },
      { name: "hotkey", type: 1 },
    ],
  };
  expect(entryOperation(member, "[]")).toMatchObject({ kind: "entries", args: [], limit: 16 });
  expect(entryOperation(member, '["9007199254740993"]', key)).toMatchObject({
    args: ["9007199254740993"],
    cursor: key,
  });
  expect(() => entryOperation(member, "[1,2,3]")).toThrow(/leading keys/);
  expect(() => entryOperation(member, "[9007199254740993]")).toThrow(/decimal strings/);
  expect(() => entryOperation({ ...member, args: [] }, "[]")).toThrow(/map/);
  expect(() => entryOperation({ ...member, kind: "prepare" }, "[]")).toThrow(/map/);
  expect(
    nativePageCursor({
      ...artifact,
      results: [{ kind: "entries", contract: { next_cursor: key }, value: [] }],
    }),
  ).toBe(key);
  expect(
    nativePageCursor({
      ...artifact,
      results: [{ kind: "entries", contract: { next_cursor: null }, value: [] }],
    }),
  ).toBeNull();
});
test("feature inputs preserve upstream key order and exact values", () => {
  expect(
    featureOperations("mechanisms", "19").map((row) => ("member" in row ? row.member : null)),
  ).toEqual(["MechanismCountCurrent", "MechanismEmissionSplit"]);
  expect(
    featureOperations("collateral", "19").map((row) => ("member" in row ? row.member : null)),
  ).toEqual(["CollateralLockShare", "CollateralDrainRatio"]);
  expect(featureOperations("hyperparameters", "19")[0]).toMatchObject({
    api: "SubnetInfoRuntimeApi",
    member: "get_subnet_hyperparams_v3",
    args: [19],
  });
  expect(featureOperations("lock", "19", key)[0]).toMatchObject({ args: [key, 19] });
  expect(featureOperations("auto-stake", "19", key)[0]).toMatchObject({ args: [key, 19] });
  expect(featureOperations("pending-children", "19", "", key)[0]).toMatchObject({
    args: [19, key],
  });
  expect(featureOperations("miner-collateral", "19", key, key)[0]).toMatchObject({
    args: [19, key, key],
  });
  const address = encodeSs58(new Uint8Array(32).fill(18))!;
  expect(featureOperations("lock", "19", ` ${address} `)[0]).toMatchObject({ args: [key, 19] });
  for (const netuid of ["", "-1", "01", "65536", "1.5", "1e3"])
    expect(() => featureOperations("mechanisms", netuid)).toThrow(/subnet number/);
  expect(() => featureOperations("lock", "0", "invalid")).toThrow(/public key/);
});
test("storage map arguments respect single tuple keys and multiple hashers", () => {
  const rows = describedMembers({
    ...artifact,
    results: [
      {
        kind: "describe",
        contract: { next_offset: 32 },
        value: [
          { kind: "storage", pallet: "P", member: "One", key_type: 2, key_parts: 1 },
          { kind: "storage", pallet: "P", member: "Two", key_type: 2, key_parts: 2 },
          { kind: "storage", pallet: "P", member: "Plain", key_type: null, key_parts: 0 },
          { kind: "runtime", api: "A", member: "Read", args: [{ name: "amount", type: 0 }] },
          { kind: "prepare", pallet: "P", member: "Call", args: [{ name: null, type: 1 }] },
          { kind: "constant", pallet: "P", member: "C" },
          null,
          { kind: "api", name: "A" },
        ],
      },
    ],
  });
  expect(rows.map((row) => row.args.map((arg) => arg.type))).toEqual([
    [2],
    [0, 1],
    [],
    [0],
    [1],
    [],
  ]);
  expect(memberOperation(rows[0], '[["9007199254740993","19"]]')).toMatchObject({
    kind: "storage",
    args: [["9007199254740993", "19"]],
  });
  expect(memberOperation(rows[3], '["9007199254740993"]')).toEqual({
    kind: "runtime",
    api: "A",
    member: "Read",
    args: ["9007199254740993"],
  });
  expect(memberOperation(rows[4], '["19"]')).toMatchObject({ kind: "prepare", args: ["19"] });
  expect(memberOperation(rows[5], "[]")).toEqual({ kind: "constant", pallet: "P", member: "C" });
  for (const text of ["{}", "[]", "[9007199254740993]", "[1e400]", "[[1e400]]", "{".repeat(32769)])
    expect(() => memberOperation(rows[3], text)).toThrow();
  expect(describedMembers(artifact)).toEqual([]);
  expect(nativeTypeLabel(artifact, 0)).toBe("u64");
  expect(nativeTypeLabel(artifact, 1)).toBe("NetUid");
  expect(nativeTypeLabel(artifact, 2)).toBe("tuple (type 2)");
  expect(nativeTypeLabel(artifact, 99)).toBe("Type 99");
  expect(nativePageOffset(artifact)).toBeNull();
  expect(
    nativePageOffset({
      ...artifact,
      results: [{ kind: "describe", contract: { next_offset: 32 } }],
    }),
  ).toBe(32);
});
test("result tables retain every exact field, enum tag, empty value and unsigned byte", () => {
  const rows = nativeValueRows({
    ...artifact,
    results: [
      {
        kind: "storage",
        pallet: "P",
        member: "Lock",
        contract: {},
        value: {
          amount: "9007199254740993",
          variant: "None",
          fields: {},
          optional: null,
          items: [],
        },
      },
      { kind: "prepare", pallet: "P", member: "Call", contract: {}, call_data: "0x0102" },
    ],
  });
  expect(rows.map((row) => row.value)).toEqual([
    "9007199254740993",
    "None",
    "{}",
    "Absent",
    "[]",
    "0x0102",
  ]);
  expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
});

test("code artifact references stay compact and bind only declared contract operations", () => {
  const url = `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/code.wasm`;
  const sha256 = "b".repeat(64);
  const input = {
    kind: "runtime" as const,
    api: "ContractsApi",
    member: "upload_code",
    args: ["0x"],
  };
  expect(codeArtifactOperation(input, "", "", "")).toBe(input);
  expect(codeArtifactOperation(input, ` ${url} `, ` ${sha256} `, " 131072 ")).toEqual({
    ...input,
    code_artifact: { url, sha256, bytes: 131072 },
  });
  expect(codeArtifactOperation(input, url, sha256, "1")).toMatchObject({
    code_artifact: { bytes: 1 },
  });
  expect(input.args).toEqual(["0x"]);
  for (const member of [
    input,
    { ...input, member: "instantiate" },
    { kind: "prepare" as const, pallet: "Contracts", member: "upload_code" },
    { kind: "prepare" as const, pallet: "Contracts", member: "instantiate_with_code" },
    { ...input, api: "EthereumRuntimeRPCApi", member: "create" },
    { kind: "prepare" as const, pallet: "EVM", member: "create" },
    { kind: "prepare" as const, pallet: "EVM", member: "create2" },
  ])
    expect(supportsNativeCodeArtifact(member)).toBe(true);
  for (const member of [
    { ...input, api: "Other" },
    { ...input, member: "call" },
    { kind: "prepare" as const, pallet: "Contracts", member: "instantiate" },
    { kind: "prepare" as const, pallet: "Other", member: "upload_code" },
    { kind: "runtime_scale" as const, api: "ContractsApi", member: "upload_code" },
    { ...input, api: "EthereumRuntimeRPCApi", member: "call" },
    { kind: "prepare" as const, pallet: "EVM", member: "call" },
  ])
    expect(supportsNativeCodeArtifact(member)).toBe(false);
  for (const fields of [
    ["", sha256, "1"],
    [url.replace("https:", "http:"), sha256, "1"],
    [url + "?x=1", sha256, "1"],
    [url.replace("raw.githubusercontent.com", "example.com"), sha256, "1"],
    [url.replace("a".repeat(40), "main"), sha256, "1"],
    [url.replace("https://", "https://x@"), sha256, "1"],
    [url + "#x", sha256, "1"],
    [url, "bad", "1"],
    [url, sha256, ""],
    [url, sha256, "0"],
    [url, sha256, "01"],
    [url, sha256, "1.5"],
    [url, sha256, "131073"],
  ])
    expect(() => codeArtifactOperation(input, fields[0]!, fields[1]!, fields[2]!)).toThrow();
  expect(() => codeArtifactOperation({ ...input, api: "Other" }, url, sha256, "1")).toThrow(
    /contract code/,
  );
});

test("precompile assistance preserves ordinary operations, exact arguments and source-pinned discovery", () => {
  const member = {
    kind: "runtime" as const,
    api: "EthereumRuntimeRPCApi",
    member: "call",
    args: [
      { name: "to", type: 0 },
      { name: "data", type: 0 },
    ],
  };
  const to = `0x${(2053).toString(16).padStart(40, "0")}`;
  const operation = memberOperation(member, JSON.stringify([to, "0x"]));
  expect(supportsNativeEvmCall(member)).toBe(true);
  expect(supportsNativeEvmCall({ ...member, member: "create" })).toBe(false);
  expect(supportsNativeEvmCall({ kind: "prepare", pallet: "EVM", member: "call" })).toBe(true);
  expect(evmCallOperation(operation, "", "[]")).toBe(operation);
  expect(
    evmCallOperation(
      operation,
      " getStake(bytes32,bytes32,uint256) ",
      `["${key}","${key}","18446744073709551616"]`,
    ),
  ).toEqual({
    ...operation,
    evm_call: {
      signature: "getStake(bytes32,bytes32,uint256)",
      args: [key, key, "18446744073709551616"],
    },
  });
  expect(() =>
    evmCallOperation({ kind: "constant", pallet: "EVM", member: "x" }, "x()", "[]"),
  ).toThrow(/Choose/);
  expect(() => evmCallOperation(operation, "x(uint256)", "[9007199254740993]")).toThrow(
    /decimal strings/,
  );
  expect(evmPrecompileOperation(member, JSON.stringify([to, "0x"]))).toEqual({
    kind: "describe",
    evm: to,
    offset: 0,
    limit: 64,
  });
  expect(() => evmPrecompileOperation(member, '["0x12","0x"]')).toThrow(/20-byte/);
  expect(nativeEvmFunctions(null)).toEqual([]);
  expect(
    nativeEvmFunctions({
      ...artifact,
      results: [
        {
          kind: "describe",
          value: [
            { kind: "evm_function", signature: "x()" },
            { kind: "other", signature: "bad" },
            null,
          ],
          contract: {},
        },
      ],
    }),
  ).toEqual(["x()"]);
});

test("decoded Solidity returns appear before raw execution bytes with exact quantities", () => {
  const view = {
    ...artifact,
    results: [
      {
        kind: "runtime" as const,
        api: "EthereumRuntimeRPCApi",
        member: "call",
        value: { variant: "Ok", fields: { value: "0xab", used_gas: "21000" } },
        evm_result: {
          status: "decoded" as const,
          values: [
            {
              stake: "9007199254740993",
              axon: { port: 443, ip: "340282366920938463463374607431768211455" },
            },
          ],
        },
        contract: {},
      },
    ],
  };
  const rows = nativeValueRows(view);
  expect(rows[0]).toMatchObject({
    field: "1. EthereumRuntimeRPCApi.call.evm_result.status",
    value: "decoded",
  });
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "1. EthereumRuntimeRPCApi.call.evm_result.values.0.stake",
        value: "9007199254740993",
      }),
      expect.objectContaining({
        field: "1. EthereumRuntimeRPCApi.call.evm_result.values.0.axon.port",
        value: "443",
      }),
      expect.objectContaining({
        field: "1. EthereumRuntimeRPCApi.call.fields.value",
        value: "0xab",
      }),
    ]),
  );
});


test("explicit collection paging preserves the submitted operation and uses typed continuation", () => {
  const operation = { kind: "runtime" as const, api: "NeuronInfoRuntimeApi", member: "get_neurons", args: [19] };
  const page = valuePageOperation(operation, "[]", "0", "16");
  expect(page).toEqual({ ...operation, value_page: { path: [], offset: 0, limit: 16 } });
  const artifact = { schema_version: 1, source: {}, types: [], results: [{
    ...operation, value: [], contract: {},
    value_page: { path: [], offset: 0, limit: 16, total: 256, next_offset: 16, collection_type: 0, element_type: 1, value_encoding: "items" },
  }] } as unknown as NativeArtifact;
  expect(nextValuePageOperation(page, artifact)).toEqual({ ...operation, value_page: { path: [], offset: 16, limit: 16 } });
  expect(operation).toEqual({ kind: "runtime", api: "NeuronInfoRuntimeApi", member: "get_neurons", args: [19] });
  for (const path of ["{}", "[null]", "[true]", "[-1]", '[""]', `["${"x".repeat(129)}"]`, JSON.stringify(Array(65).fill(0)), "x".repeat(16385)])
    expect(() => valuePageOperation(operation, path, "0", "16")).toThrow();
  for (const [offset, limit] of [["-1", "1"], ["1.5", "1"], ["262145", "1"], ["0", "0"], ["0", "65"]])
    expect(() => valuePageOperation(operation, "[]", offset!, limit!)).toThrow();
  expect(() => valuePageOperation({ kind: "describe", offset: 0, limit: 32 }, "[]", "0", "16")).toThrow();
  expect(() => valuePageOperation({ kind: "runtime_scale", api: operation.api, member: operation.member, input: "0x" }, "[]", "0", "16")).toThrow();
  expect(() => valuePageOperation({ ...operation, evm_call: { signature: "x()", args: [] } }, "[]", "0", "16")).toThrow();
  expect(valuePageOperation({ kind: "runtime_scale", api: operation.api, member: operation.member, input: "0x", decode_inner: true }, "[]", "0", "16")).toMatchObject({ value_page: { offset: 0 } });
  expect(() => nextValuePageOperation(page, { ...artifact, results: [] })).toThrow();
  expect(() => nextValuePageOperation(page, { ...artifact, results: [{ ...artifact.results[0]!, value_page: { ...artifact.results[0]!.value_page!, next_offset: null } }] })).toThrow();
});
