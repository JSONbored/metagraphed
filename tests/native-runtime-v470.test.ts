import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import wrapped, {
  V470_METADATA_SHA256,
  V470_RUNTIME_VERSION,
} from "./fixtures/native-v470-compiled.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeField,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeHex,
  nativeStorageKey,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";
import { handleNativeRuntime } from "../workers/request-handlers/native-runtime.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { NativeCodeArtifactSchema } from "../schemas-src/routes/native-runtime.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import {
  UninhabitedType,
  sampleNativeValue,
} from "./fixtures/native-compiled-values.ts";

const bare = unwrapNativeMetadata(wrapped)!;
const model = decodeNativeMetadata(bare);
const registry = new TypeRegistry();
const reference = new Metadata(registry, Buffer.from(bare.slice(2), "hex"));
registry.setMetadata(reference);
const hash = `0x${"33".repeat(32)}`;

const sample = (id: number) => sampleNativeValue(model, id);
function fixture(codeHash: string | null = null) {
  const executions: { method: string; params: unknown[] }[] = [];
  let metadataReads = 0;
  const rpc: BasketRpc = async (method, params) => {
    switch (method) {
      case "chain_getFinalizedHead":
        return hash;
      case "chain_getHeader":
        return { number: "0x1f4" };
      case "chain_getBlockHash":
        return `0x${"44".repeat(32)}`;
      case "state_getRuntimeVersion":
        return V470_RUNTIME_VERSION;
      case "state_getStorageHash":
        return codeHash;
      case "state_call": {
        if (params[0] === "Metadata_metadata_at_version") {
          metadataReads++;
          return wrapped;
        }
        executions.push({ method, params });
        const api = model.apis.find((api) =>
          String(params[0]).startsWith(`${api.name}_`),
        )!;
        const name = String(params[0]).slice(api.name.length + 1);
        const member = api.methods.find((method) => method.name === name)!;
        return nativeHex(
          encodeNativeValue(model, member.output, sample(member.output)),
        );
      }
      default:
        throw new Error(`Unexpected compiled ABI fixture call: ${method}`);
    }
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return { rpc, executions, metadataReads: () => metadataReads };
}

test("full compiled v470 metadata matches the independent reference registry, APIs and every constant", () => {
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(wrapped.slice(2), "hex"))
      .digest("hex"),
    V470_METADATA_SHA256,
  );
  assert.equal(model.types.size, 808);
  assert.equal(model.pallets.length, 28);
  assert.equal(model.apis.length, 25);
  assert.equal(V470_RUNTIME_VERSION.specVersion, 470);
  assert.deepEqual(
    registry.createType("RuntimeVersion", V470_RUNTIME_VERSION).toJSON(),
    V470_RUNTIME_VERSION,
  );
  assert.deepEqual(
    [...model.types.values()].map((row) => [row.id, row.path]),
    reference.asV15.lookup.types.map((row) => [
      row.id.toNumber(),
      row.type.path.map(String),
    ]),
  );
  assert.deepEqual(
    model.pallets.map((row) => [row.name, row.index]),
    reference.asV15.pallets.map((row) => [
      row.name.toString(),
      row.index.toNumber(),
    ]),
  );
  assert.deepEqual(
    model.apis,
    reference.asV15.apis.map((api) => ({
      name: api.name.toString(),
      methods: api.methods.map((method) => ({
        name: method.name.toString(),
        inputs: method.inputs.map((input) => ({
          name: input.name.toString(),
          type: input.type.toNumber(),
        })),
        output: method.output.toNumber(),
      })),
    })),
  );
  let constants = 0;
  for (const pallet of model.pallets)
    for (const constant of pallet.constants) {
      const bytes = encodeNativeValue(
        model,
        constant.type,
        decodeNativeValue(model, constant.type, constant.value),
      );
      assert.equal(
        nativeHex(bytes),
        constant.value,
        `${pallet.name}.${constant.name}`,
      );
      const independent = registry.createTypeUnsafe(`Lookup${constant.type}`, [
        Buffer.from(constant.value.slice(2), "hex"),
      ]);
      assert.equal(independent.encodedLength, bytes.length);
      assert.equal(nativeHex(independent.toU8a()), constant.value);
      constants++;
    }
  assert.ok(constants > 0);
  console.log(
    "NATIVE_V470_COMPILED_ABI_FIXTURE",
    JSON.stringify({
      types: model.types.size,
      pallets: model.pallets.length,
      apis: model.apis.length,
      constants,
      fixture: true,
      production: false,
    }),
  );
});

test("every compiled v470 pallet call can be prepared and independently decoded with the exact pallet and call indices", async () => {
  let prepared = 0;
  const uninhabited: string[] = [];
  const f = fixture(`0x${"77".repeat(32)}`);
  for (const pallet of model.pallets) {
    if (pallet.calls === null) continue;
    const calls = model.types.get(pallet.calls)!.definition;
    assert.equal(calls.kind, "variant");
    if (calls.kind !== "variant") continue;
    for (const call of calls.variants) {
      let args: NativeValue[];
      try {
        args = call.fields.map((field) => sample(field.type));
      } catch (error) {
        if (!(error instanceof UninhabitedType)) throw error;
        // Grandpa's configured Void key-ownership proof has no value. It
        // cannot be fabricated into a callable extrinsic by any client.
        assert.equal(pallet.name, "Grandpa");
        assert.match(call.name, /^report_equivocation/);
        assert.throws(
          () =>
            encodeNativeValue(model, error.id, { variant: "Void", fields: {} }),
          /Invalid native enum variant/,
        );
        uninhabited.push(`${pallet.name}.${call.name}`);
        continue;
      }
      const result = await queryNativeRuntime(
        {
          as_of: hash,
          operations: [
            { kind: "prepare", pallet: pallet.name, member: call.name, args },
          ],
        },
        f.rpc,
      );
      const encoded = result.results[0]!.call_data!;
      const independent = registry.createType(
        "Call",
        Buffer.from(encoded.slice(2), "hex"),
      );
      assert.deepEqual(
        [...independent.callIndex],
        [pallet.index, call.index],
        `${pallet.name}.${call.name}`,
      );
      assert.equal(nativeHex(independent.toU8a()), encoded);
      assert.equal(independent.encodedLength, (encoded.length - 2) / 2);
      prepared++;
    }
  }
  assert.ok(prepared > 0);
  assert.equal(f.executions.length, 0);
  console.log(
    "NATIVE_V470_PREPARED_CALL_FIXTURE",
    JSON.stringify({
      prepared_calls: prepared,
      uninhabited_proof_calls: uninhabited,
      execution_rpcs: 0,
      fixture: true,
      production: false,
    }),
  );
}, 60000);

test("compiled v470 EVM and Wasm runtime signatures encode exact bounded execution requests including authorization_list", async () => {
  for (const [apiName, memberName] of [
    ["EthereumRuntimeRPCApi", "call"],
    ["EthereumRuntimeRPCApi", "create"],
    ["ContractsApi", "call"],
    ["ContractsApi", "instantiate"],
    ["ContractsApi", "upload_code"],
  ]) {
    const api = model.apis.find((row) => row.name === apiName)!;
    const member = api.methods.find((row) => row.name === memberName)!;
    const args = member.inputs.map((field) => sample(field.type));
    member.inputs.forEach((field, index) => {
      if (field.name === "gas_limit")
        args[index] =
          apiName === "ContractsApi"
            ? {
                variant: "Some",
                fields: { ref_time: "100000000000", proof_size: "32768" },
              }
            : ["500000", "0", "0", "0"];
    });
    if (apiName === "EthereumRuntimeRPCApi")
      assert.ok(
        member.inputs.some((field) => field.name === "authorization_list"),
      );
    const f = fixture();
    const result = await queryNativeRuntime(
      {
        operations: [
          { kind: "runtime", api: apiName, member: memberName, args },
        ],
      },
      f.rpc,
    );
    assert.equal(f.executions.length, 1);
    const pieces = member.inputs.map((field, index) => {
      const encoded = encodeNativeValue(model, field.type, args[index]!);
      const independent = registry.createTypeUnsafe(`Lookup${field.type}`, [
        encoded,
      ]);
      assert.equal(independent.encodedLength, encoded.length);
      assert.equal(nativeHex(independent.toU8a()), nativeHex(encoded));
      return encoded;
    });
    assert.deepEqual(f.executions[0]!.params, [
      `${apiName}_${memberName}`,
      nativeHex(Buffer.concat(pieces)),
      hash,
    ]);
    const output = encodeNativeValue(
      model,
      member.output,
      result.results[0]!.value!,
    );
    const independent = registry.createTypeUnsafe(`Lookup${member.output}`, [
      output,
    ]);
    assert.equal(independent.encodedLength, output.length);
    assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
  }
});

test("warm compiled v470 contracts remove the full metadata transfer and parse while preserving response bytes", async () => {
  const f = fixture(`0x${"88".repeat(32)}`);
  const input = {
    operations: [{ kind: "constant", pallet: "System", member: "SS58Prefix" }],
  };
  const cold = await queryNativeRuntime(input, f.rpc);
  const warm = await queryNativeRuntime(input, f.rpc);
  assert.equal(JSON.stringify(warm), JSON.stringify(cold));
  assert.equal(f.metadataReads(), 1);
  assert.equal(f.executions.length, 0);
  console.log(
    "NATIVE_V470_METADATA_REUSE_FIXTURE",
    JSON.stringify({
      metadata_reads_removed: 1,
      metadata_decodes_removed: 1,
      metadata_wire_hex_bytes_removed: Buffer.byteLength(wrapped),
      identity_hex_bytes_added: 66,
      response_bytes: Buffer.byteLength(JSON.stringify(warm)),
      bytes_equal: true,
      fixture: true,
      production: false,
    }),
  );
});

test("all compiled ShieldApi decode methods are usable reads with exact reference bytes and no submission path", async () => {
  const api = model.apis.find((row) => row.name === "ShieldApi")!;
  assert.deepEqual(
    api.methods.map((row) => row.name),
    [
      "try_decode_shielded_tx",
      "is_shielded_using_current_key",
      "try_unshield_tx",
    ],
  );
  const f = fixture();
  const description = await queryNativeRuntime(
    { operations: [{ kind: "describe", api: api.name }] },
    f.rpc,
  );
  assert.equal((description.results[0]!.value as NativeValue[]).length, 3);
  for (const member of api.methods) {
    const args = member.inputs.map((field) => sample(field.type));
    const result = await queryNativeRuntime(
      {
        operations: [
          { kind: "runtime", api: api.name, member: member.name, args },
        ],
      },
      f.rpc,
    );
    const output = encodeNativeValue(
      model,
      member.output,
      result.results[0]!.value!,
    );
    const independent = registry.createTypeUnsafe(`Lookup${member.output}`, [
      output,
    ]);
    assert.equal(independent.encodedLength, output.length);
    assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
  }
  assert.deepEqual(
    f.executions.map((row) => row.params[0]),
    api.methods.map((row) => `${api.name}_${row.name}`),
  );
});

test("compiled v470 API and storage reads preserve full EVM and Wasm code within existing response bounds", async () => {
  const api = model.apis.find((row) => row.name === "EthereumRuntimeRPCApi")!;
  const method = api.methods.find((row) => row.name === "account_code_at")!;
  const pallet = model.pallets.find((row) => row.name === "Contracts")!;
  const storage = pallet.storage.find((row) => row.name === "PristineCode")!;
  const maxCode = pallet.constants.find((row) => row.name === "MaxCodeLen")!;
  assert.equal(decodeNativeValue(model, maxCode.type, maxCode.value), "131072");
  const evmCode = `0x${"a5".repeat(24_576)}`;
  const wasmCode = `0x${"5a".repeat(131_072)}`;
  const args = method.inputs.map((field) => sample(field.type));
  const keyArgs = [sample(storage.key!)];
  const storageKey = nativeStorageKey(model, pallet.prefix, storage, keyArgs);
  // These bytes qualify the compiled ABI and public reader, not code execution.
  const evmResult = nativeHex(
    registry.createTypeUnsafe(`Lookup${method.output}`, [evmCode]).toU8a(),
  );
  const wasmResult = nativeHex(
    registry.createTypeUnsafe(`Lookup${storage.value}`, [wasmCode]).toU8a(),
  );
  const f = fixture();
  const reads: { method: string; params: unknown[] }[] = [];
  const rpc: BasketRpc = async (name, params) => {
    if (name === "state_call" && params[0] === `${api.name}_${method.name}`) {
      reads.push({ method: name, params });
      return evmResult;
    }
    if (name === "state_getStorage") {
      reads.push({ method: name, params });
      assert.deepEqual(params, [storageKey, hash]);
      return wasmResult;
    }
    return f.rpc(name, params);
  };
  rpc.batch = async (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  const input = {
    operations: [
      { kind: "runtime", api: api.name, member: method.name, args },
      {
        kind: "storage",
        pallet: pallet.name,
        member: storage.name,
        args: keyArgs,
      },
    ],
  };
  const result = await queryNativeRuntime(input, rpc);
  assert.equal(result.results[0]!.value, evmCode);
  assert.equal(result.results[1]!.value, wasmCode);
  assert.equal(result.results[1]!.is_default, false);
  assert.equal(result.source.finalized_block_hash, hash);
  assert.equal(reads.length, 2);
  assert.equal(reads.filter((row) => row.method === "state_call").length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 524_288);
  // Overall response budgeting is unchanged even when each value fits its cap.
  await assert.rejects(
    () =>
      queryNativeRuntime(
        { operations: [input.operations[1], input.operations[1]] },
        rpc,
      ),
    /response exceeds byte budget/,
  );
  console.log(
    "NATIVE_V470_CODE_READ_FIXTURE",
    JSON.stringify({
      evm_code_bytes: 24_576,
      wasm_code_bytes: 131_072,
      previous_bulk_byte_limit: 16_384,
      value_byte_budget: 262_144,
      response_byte_budget: 524_288,
      response_bytes: Buffer.byteLength(JSON.stringify(result)),
      exact_code_bytes: true,
      fixture: true,
      production: false,
    }),
  );
});

test("compiled v470 full Wasm artifact references simulate uploads and prepare exact native calls with compact requests", async () => {
  const pallet = model.pallets.find((row) => row.name === "Contracts")!;
  const calls = model.types.get(pallet.calls!)!.definition;
  assert.equal(calls.kind, "variant");
  if (calls.kind !== "variant") return;
  const api = model.apis.find((row) => row.name === "ContractsApi")!;
  const data = Buffer.alloc(131_072, 0xa5);
  const artifact = {
    url: `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/code.wasm`,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
  for (const [kind, memberName] of [
    ["runtime", "upload_code"],
    ["runtime", "instantiate"],
    ["prepare", "upload_code"],
    ["prepare", "instantiate_with_code"],
  ] as const) {
    const fields: NativeField[] =
      kind === "runtime"
        ? api.methods.find((row) => row.name === memberName)!.inputs
        : calls.variants.find((row) => row.name === memberName)!.fields;
    const args = fields.map((field) => sample(field.type));
    fields.forEach((field, index) => {
      if (field.name === "code")
        args[index] =
          kind === "runtime" && memberName === "instantiate"
            ? { variant: "Upload", fields: "0x" }
            : "0x";
      if (field.name === "gas_limit" && kind === "runtime")
        args[index] = {
          variant: "Some",
          fields: { ref_time: "100000000000", proof_size: "32768" },
        };
    });
    const operation = {
      kind,
      ...(kind === "runtime" ? { api: api.name } : { pallet: pallet.name }),
      member: memberName,
      args,
      code_artifact: artifact,
    };
    const f = fixture();
    let fetches = 0;
    const fetchImpl = (async (url, init) => {
      fetches++;
      assert.equal(url, artifact.url);
      assert.equal(init!.redirect, "manual");
      return new Response(data);
    }) as typeof fetch;
    const result = await queryNativeRuntime(
      { operations: kind === "runtime" ? [operation, operation] : [operation] },
      f.rpc,
      fetchImpl,
    );
    assert.equal(fetches, 1);
    if (kind === "runtime")
      assert.deepEqual(result.results[0], result.results[1]);
    assert.equal(f.executions.length, kind === "runtime" ? 1 : 0);
    const codeIndex = fields.findIndex((field) => field.name === "code");
    const code =
      kind === "runtime" && memberName === "instantiate"
        ? { variant: "Upload", fields: nativeHex(data) }
        : nativeHex(data);
    const expected = args.map((value, index) =>
      index === codeIndex ? code : value,
    );
    const pieces = fields.map((field, index) =>
      registry
        .createTypeUnsafe(`Lookup${field.type}`, [
          encodeNativeValue(model, field.type, expected[index]!),
        ])
        .toU8a(),
    );
    if (kind === "runtime")
      assert.deepEqual(f.executions[0]!.params, [
        `ContractsApi_${memberName}`,
        nativeHex(Buffer.concat(pieces)),
        hash,
      ]);
    else {
      const callIndex: number = calls.variants.find(
        (row) => row.name === memberName,
      )!.index;
      assert.equal(
        result.results[0]!.call_data,
        nativeHex(
          Buffer.concat([Buffer.from([pallet.index, callIndex]), ...pieces]),
        ),
      );
    }
    assert.deepEqual(
      (result.results[0]!.contract as { code_artifact: unknown }).code_artifact,
      artifact,
    );
    assert.deepEqual(
      args[codeIndex],
      kind === "runtime" && memberName === "instantiate"
        ? { variant: "Upload", fields: "0x" }
        : "0x",
    );
    if (kind === "runtime") {
      const inline = { ...operation, args: expected, code_artifact: undefined };
      await assert.rejects(
        () => queryNativeRuntime({ operations: [inline] }, f.rpc, fetchImpl),
        /Native request exceeds byte budget/,
      );
      const before = f.executions.length;
      await assert.rejects(
        () =>
          queryNativeRuntime(
            {
              operations: [
                operation,
                {
                  ...operation,
                  args: args.map((value, index) =>
                    fields[index]!.name === "origin"
                      ? `0x${"22".repeat(32)}`
                      : value,
                  ),
                },
              ],
            },
            f.rpc,
            fetchImpl,
          ),
        /aggregate/,
      );
      assert.equal(f.executions.length, before);
    }
    if (kind === "prepare") {
      // Keep full method bytes inside the unchanged public response cap.
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 524_288);
    }
    console.log(
      "NATIVE_V470_CODE_ARTIFACT_FIXTURE",
      JSON.stringify({
        kind,
        member: memberName,
        code_bytes: data.length,
        request_bytes: Buffer.byteLength(
          JSON.stringify({ operations: [operation] }),
        ),
        inline_code_hex_bytes_avoided: data.length * 2,
        artifact_fetches: 1,
        execution_rpcs: kind === "runtime" ? 1 : 0,
        fixture: true,
        production: false,
      }),
    );
  }
});

test("full code references preserve REST/MCP bytes through the actual correlated RPC transport", async () => {
  const api = model.apis.find((row) => row.name === "ContractsApi")!;
  const method = api.methods.find((row) => row.name === "upload_code")!;
  const data = Buffer.alloc(131_072, 0xa5);
  const artifact = {
    url: `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/code.wasm`,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
  const args = method.inputs.map((field) =>
    field.name === "code" ? "0x" : sample(field.type),
  );
  const input = {
    network: "finney",
    as_of: hash,
    operations: [
      {
        kind: "runtime",
        api: api.name,
        member: method.name,
        args,
        code_artifact: artifact,
      },
    ],
  };
  const f = fixture();
  let artifactReads = 0;
  const executionBodies: number[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      if (String(url) === artifact.url) {
        artifactReads++;
        return new Response(data);
      }
      assert.equal(String(url), "https://entrypoint-finney.opentensor.ai:443");
      type Call = { id: number; method: string; params: unknown[] };
      const body = JSON.parse(String(init!.body)) as Call | Call[];
      const rows = Array.isArray(body) ? body : [body];
      if (rows.some((row) => row.params?.[0] === "ContractsApi_upload_code"))
        executionBodies.push(Buffer.byteLength(String(init!.body)));
      const replies = await Promise.all(
        rows.map(async (row) => ({
          jsonrpc: "2.0",
          id: row.id,
          result: await f.rpc(row.method, row.params),
        })),
      );
      return Response.json(
        Array.isArray(body) ? replies.reverse() : replies[0],
      );
    });
  const parse = vi.spyOn(NativeCodeArtifactSchema, "parse");
  const keys: string[] = [];
  const env = apiEnv({
    ...createLocalArtifactEnv(),
    RPC_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    },
  });
  try {
    const rest = await handleNativeRuntime(
      new Request("https://api.metagraph.sh/api/v1/native-runtime", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.1",
        },
        body: JSON.stringify(input),
      }),
      env,
    );
    assert.equal(rest.status, 200);
    const restData = ((await rest.json()) as { data: unknown }).data;
    const mcp = await MCP_TOOLS.find(
      (row) => row.name === "get_native_runtime",
    )!.handler(input, { env, clientIp: "192.0.2.1" });
    assert.equal(JSON.stringify(mcp), JSON.stringify(restData));
    assert.deepEqual(keys, [
      "native-runtime:192.0.2.1",
      "native-runtime:192.0.2.1",
    ]);
    assert.equal(artifactReads, 2);
    assert.equal(f.executions.length, 2);
    assert.equal(parse.mock.calls.length, 0);
    assert.ok(executionBodies.every((bytes) => bytes > 262_144));
    const artifactFetches = artifactReads;
    const inline = {
      ...input,
      operations: [
        {
          ...input.operations[0],
          code_artifact: undefined,
          args: args.map((value, index) =>
            method.inputs[index]!.name === "code" ? nativeHex(data) : value,
          ),
        },
      ],
    };
    const rejected = await handleNativeRuntime(
      new Request("https://api.metagraph.sh/api/v1/native-runtime", {
        method: "POST",
        body: JSON.stringify(inline),
      }),
      env,
    );
    assert.equal(rejected.status, 400);
    assert.equal(artifactReads, artifactFetches);
    const before = f.executions.length;
    const invalid = {
      ...input,
      operations: [
        {
          ...input.operations[0],
          code_artifact: { ...artifact, sha256: "0".repeat(64) },
        },
      ],
    };
    const failed = await handleNativeRuntime(
      new Request("https://api.metagraph.sh/api/v1/native-runtime", {
        method: "POST",
        body: JSON.stringify(invalid),
      }),
      env,
    );
    assert.equal(failed.status, 502);
    assert.equal(
      ((await failed.json()) as { error: { code: string } }).error.code,
      "native_runtime_failed",
    );
    assert.equal(f.executions.length, before);
    console.log(
      "NATIVE_CODE_ARTIFACT_HTTP_MCP_FIXTURE",
      JSON.stringify({
        code_bytes: data.length,
        request_bytes: Buffer.byteLength(JSON.stringify(input)),
        execution_request_bytes: executionBodies,
        redundant_artifact_parses: 0,
        exact_rest_mcp_bytes: true,
        fixture: true,
        production: false,
      }),
    );
  } finally {
    parse.mockRestore();
    fetch.mockRestore();
  }
});

test("compiled constants and storage pages preserve source declarations and storage defaults", async () => {
  const system = model.pallets.find((row) => row.name === "System")!;
  const version = system.constants.find((row) => row.name === "Version")!;
  const full = decodeNativeValue(model, version.type, version.value) as {
    apis: NativeValue[];
  };
  const f = fixture();
  const constant = await queryNativeRuntime(
    {
      operations: [
        {
          kind: "constant",
          pallet: "System",
          member: "Version",
          value_page: { path: ["apis"], offset: 0, limit: 2 },
        },
      ],
    },
    f.rpc,
  );
  assert.deepEqual(constant.results[0]!.value, full.apis.slice(0, 2));
  assert.equal(constant.results[0]!.value_page!.total, full.apis.length);
  assert.equal(f.executions.length, 0);
  const pallet = model.pallets.find((row) => row.name === "SubtensorModule")!;
  const item = pallet.storage.find((row) => row.name === "Active")!;
  const values = [true, false, true];
  const hex = nativeHex(encodeNativeValue(model, item.value, values));
  let current: string | null = hex;
  const rpc: BasketRpc = (method, params) =>
    method === "state_getStorage"
      ? Promise.resolve(current)
      : f.rpc(method, params);
  rpc.batch = (calls) =>
    Promise.all(calls.map((row) => rpc(row.method, row.params)));
  const operation = {
    kind: "storage",
    pallet: pallet.name,
    member: item.name,
    args: [19],
    value_page: { path: [], offset: 1, limit: 1 },
  };
  const actual = await queryNativeRuntime(
    { as_of: hash, operations: [operation] },
    rpc,
  );
  assert.deepEqual(actual.results[0]!.value, [false]);
  assert.equal(actual.results[0]!.is_default, false);
  current = null;
  const fallback = await queryNativeRuntime(
    {
      operations: [
        { ...operation, value_page: { ...operation.value_page, offset: 0 } },
      ],
    },
    rpc,
  );
  assert.deepEqual(fallback.results[0]!.value, []);
  assert.equal(fallback.results[0]!.is_default, true);
  assert.equal(fallback.results[0]!.value_page!.total, 0);
});
