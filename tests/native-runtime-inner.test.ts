import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import eras from "./fixtures/native-runtime-legacy-compiled.ts";
import { nativeRuntimeInnerCatalogue } from "../src/native-runtime-inner-catalogue.ts";
import { nativeInnerRecord } from "../src/native-runtime-inner.ts";
import {
  NativeScaleReader,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
} from "../src/native-runtime-metadata.ts";
import {
  encodeNativeValue,
  nativeHex,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleNativeRuntime } from "../workers/request-handlers/native-runtime.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

afterEach(() => vi.restoreAllMocks());
const at = `0x${"33".repeat(32)}`;
const sha = (bytes: Uint8Array) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
function recordSample(
  model: NativeMetadata,
  id: number,
  depth = 0,
): NativeValue {
  assert.ok(depth < 32);
  const d = model.types.get(id)!.definition;
  const child = (type: number) => recordSample(model, type, depth + 1);
  const fields = (
    rows: { name: string | null; type: number }[],
  ): NativeValue =>
    rows.length === 1 && rows[0]!.name === null
      ? child(rows[0]!.type)
      : rows.every((row) => row.name !== null)
        ? Object.fromEntries(rows.map((row) => [row.name!, child(row.type)]))
        : rows.map((row) => child(row.type));
  if (d.kind === "primitive")
    return d.primitive === 0
      ? true
      : d.primitive === 1
        ? "A"
        : d.primitive === 2
          ? "legacy"
          : d.primitive === 6
            ? "9007199254740993"
            : "7";
  if (d.kind === "compact") return child(d.type);
  if (d.kind === "sequence") {
    const element = model.types.get(d.type)!.definition;
    if (element.kind === "primitive" && element.primitive === 3)
      return "0x6100ff";
    const item = child(d.type);
    return element.kind === "variant" &&
      element.variants.some((row) => row.name === "None")
      ? [item, { variant: "None", fields: {} }]
      : [item];
  }
  if (d.kind === "array") {
    const element = model.types.get(d.type)!.definition;
    return element.kind === "primitive" && element.primitive === 3
      ? `0x${"ab".repeat(d.length)}`
      : Array.from({ length: d.length }, () => child(d.type));
  }
  if (d.kind === "tuple") return d.types.map(child);
  if (d.kind === "composite") return fields(d.fields);
  if (d.kind === "variant") {
    const variant =
      d.variants.find((row) => row.name === "Some") ?? d.variants[0]!;
    return { variant: variant.name, fields: fields(variant.fields) };
  }
  throw new Error("Unexpected bit layout in legacy inner fixture");
}
function fixture(index: number, format: 14 | 15) {
  const era = eras[index]!,
    model = decodeNativeMetadata(unwrapNativeMetadata(era.v15)!);
  let method = "",
    input = "",
    output = "";
  const calls: unknown[][] = [];
  const rpc: BasketRpc = async (name, params) => {
    if (name === "chain_getFinalizedHead") return at;
    if (name === "chain_getHeader") return { number: "0x1f4" };
    if (name === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
    if (name === "state_getRuntimeVersion") return era.runtimeVersion;
    if (name === "state_getStorageHash")
      return sha(Buffer.from(`inner:${era.spec}:${format}`));
    if (name === "state_getMetadata") return unwrapNativeMetadata(era.v14);
    assert.equal(name, "state_call");
    if (params[0] === "Metadata_metadata_at_version")
      return format === 15 ? era.v15 : "0x00";
    assert.deepEqual(params, [method, input, at]);
    calls.push(params);
    return output;
  };
  rpc.batch = (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return {
    era,
    model,
    rpc,
    calls,
    select(api: string, member: string, inner: string) {
      const row = model.apis
        .find((item) => item.name === api)!
        .methods.find((item) => item.name === member)!;
      const args = row.inputs.map((field) =>
        sampleNativeValue(model, field.type),
      );
      method = `${api}_${member}`;
      input = nativeHex(
        Buffer.concat(
          row.inputs.map((field, i) =>
            encodeNativeValue(model, field.type, args[i]!),
          ),
        ),
      );
      output = nativeHex(encodeNativeValue(model, row.output, inner));
      return format === 15
        ? { kind: "runtime" as const, api, member, args }
        : { kind: "runtime_scale" as const, api, member, input };
    },
  };
}

for (let index = 0; index < 8; index++)
  test(`compiled spec ${eras[index]!.spec} decodes every legacy record in both native paths without extra execution`, async () => {
    const release = nativeRuntimeInnerCatalogue.find(
      (row) => row.spec === eras[index]!.spec,
    )!;
    assert.equal(release.commit, eras[index]!.commit);
    assert.equal(release.methods.length, 14);
    const original = decodeNativeMetadata(
      unwrapNativeMetadata(eras[index]!.v15)!,
    );
    const inner = {
      ...original,
      types: new Map(release.types.map((type) => [type.id, type])),
    };
    let bindings = 0,
      absenceCases = 0;
    for (const format of [14, 15] as const)
      for (const method of release.methods) {
        const f = fixture(index, format),
          value = recordSample(inner, method.root_type),
          bytes = nativeHex(encodeNativeValue(inner, method.root_type, value));
        const operation = f.select(method.api, method.member, bytes);
        const response = await queryNativeRuntime(
          {
            operations: [
              operation,
              { ...operation, decode_inner: true },
              { ...operation, decode_inner: true },
            ],
          },
          f.rpc,
        );
        assert.equal(f.calls.length, 1);
        assert.deepEqual(response.results[1], response.results[2]);
        assert.equal(response.results[0]!.inner_result, undefined);
        assert.equal(response.results[1]!.value, response.results[0]!.value);
        assert.deepEqual(response.results[1]!.inner_result, value);
        assert.equal(response.source.metadata_version, format);
        const contract = response.results[1]!.contract as {
          inner_scale: {
            source_commit: string;
            root_type: number;
            types: unknown[];
          };
        };
        assert.equal(contract.inner_scale.source_commit, release.commit);
        assert.equal(contract.inner_scale.root_type, method.root_type);
        assert.ok(contract.inner_scale.types.length <= release.types.length);
        const unchanged = await queryNativeRuntime(
          { operations: [{ ...operation, decode_inner: false }] },
          f.rpc,
        );
        assert.deepEqual(unchanged.results[0], response.results[0]);
        bindings++;
        if (method.empty_is_none) {
          const absent = f.select(method.api, method.member, "0x");
          const result = await queryNativeRuntime(
            { operations: [{ ...absent, decode_inner: true }] },
            f.rpc,
          );
          assert.equal(result.results[0]!.inner_result, null);
          absenceCases++;
        }
      }
    console.log(
      "NATIVE_INNER_RECORD_FIXTURE",
      JSON.stringify({
        spec: release.spec,
        source_commit: release.commit,
        decoded_bindings: bindings,
        singular_absence_cases: absenceCases,
        execution_requests_per_mixed_duplicate: 1,
        additional_execution_requests_for_decoding: 0,
        fixture: true,
        production: false,
      }),
    );
  }, 180000);

test("nonempty legacy delegate records retain exact compact boundaries, nested stake and account bytes", () => {
  const release = nativeRuntimeInnerCatalogue.find((row) => row.spec === 210)!,
    method = release.methods.find((row) => row.member === "get_delegate")!;
  const model = {
    ...decodeNativeMetadata(unwrapNativeMetadata(eras[1]!.v15)!),
    types: new Map(release.types.map((type) => [type.id, type])),
  };
  const value = {
    delegate_ss58: `0x${"ab".repeat(32)}`,
    take: "65535",
    nominators: [[`0x${"cd".repeat(32)}`, "9007199254740993"]],
    owner_ss58: `0x${"ef".repeat(32)}`,
    registrations: ["64", "16384"],
    validator_permits: ["2"],
    return_per_1000: "63",
    total_daily_return: "1073741824",
  };
  const golden = `0x${"ab".repeat(32)}feff030004${"cd".repeat(32)}0f01000000000020${"ef".repeat(32)}080101020001000408fc0300000040`;
  assert.equal(
    nativeHex(encodeNativeValue(model, method.root_type, value)),
    golden,
  );
  const read = nativeInnerRecord(
    model,
    210,
    `0x${release.metadata_sha256[1]}`,
    "DelegateInfoRuntimeApi",
    "get_delegate",
  );
  assert.deepEqual(read.decode(golden), value);
});

test("unqualified layouts and malformed nested SCALE fail before interpretation or execution", async () => {
  const f = fixture(1, 15),
    release = nativeRuntimeInnerCatalogue.find((row) => row.spec === 210)!;
  for (const [spec, hash, api, member] of [
    [210, `0x${"00".repeat(32)}`, "DelegateInfoRuntimeApi", "get_delegate"],
    [
      470,
      `0x${release.metadata_sha256[1]}`,
      "DelegateInfoRuntimeApi",
      "get_delegate",
    ],
    [210, `0x${release.metadata_sha256[1]}`, "Core", "execute_block"],
    [
      210,
      `zz${release.metadata_sha256[1]}`,
      "DelegateInfoRuntimeApi",
      "get_delegate",
    ],
  ] as const)
    assert.throws(
      () => nativeInnerRecord(f.model, spec, hash, api, member),
      /source-qualified opaque record/,
    );
  const read = nativeInnerRecord(
    f.model,
    210,
    `0x${release.metadata_sha256[1]}`,
    "DelegateInfoRuntimeApi",
    "get_delegate",
  );
  for (const value of [
    null,
    "0x01",
    "0xzz",
    `0x${"00".repeat(NATIVE_RUNTIME_LIMITS.valueBytes + 1)}`,
  ])
    assert.throws(() => read.decode(value));
  assert.equal(read.decode("0x"), null);
  assert.equal(read.decode("0x00", true), null);
  assert.throws(() => read.decode("0x0000", true), /Trailing/);
  assert.throws(() => read.decode("0x0500", true), /Noncanonical/);
  const bad = {
    kind: "runtime",
    api: "AccountNonceApi",
    member: "account_nonce",
    args: [`0x${"ab".repeat(32)}`],
    decode_inner: true,
  };
  await assert.rejects(
    queryNativeRuntime({ operations: [bad] }, f.rpc),
    /source-qualified opaque record/,
  );
  assert.equal(f.calls.length, 0);
});

test("REST and MCP expose identical opt-in records, source layouts and original bytes", async () => {
  const f = fixture(1, 15),
    operation = {
      ...f.select("DelegateInfoRuntimeApi", "get_delegate", "0x"),
      decode_inner: true,
    };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const raw = JSON.parse(String(init?.body));
    const reply = async (row: {
      id: unknown;
      method: string;
      params: unknown[];
    }) => ({
      jsonrpc: "2.0",
      id: row.id,
      result: await f.rpc(row.method, row.params),
    });
    return Response.json(
      Array.isArray(raw) ? await Promise.all(raw.map(reply)) : await reply(raw),
    );
  });
  const env = apiEnv(createLocalArtifactEnv());
  const response = await handleNativeRuntime(
    new Request("https://api.metagraph.sh/api/v1/native-runtime", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
      },
      body: JSON.stringify({ operations: [operation] }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const rest = ((await response.json()) as { data: unknown }).data;
  const mcp = await MCP_TOOLS.find(
    (row) => row.name === "get_native_runtime",
  )!.handler({ operations: [operation] }, { env, clientIp: "192.0.2.1" });
  assert.equal(JSON.stringify(mcp), JSON.stringify(rest));
  assert.equal(f.calls.length, 2);
});

test("duplicate native results decode once per wire type and inner contract while retaining independent public values", async () => {
  const release = nativeRuntimeInnerCatalogue.find((row) => row.spec === 210)!,
    method = release.methods.find((row) => row.member === "get_delegates")!;
  const base = decodeNativeMetadata(unwrapNativeMetadata(eras[1]!.v15)!);
  const model = {
    ...base,
    types: new Map(release.types.map((type) => [type.id, type])),
  };
  const value = recordSample(model, method.root_type),
    bytes = nativeHex(encodeNativeValue(model, method.root_type, value));
  for (const format of [14, 15] as const) {
    const f = fixture(1, format),
      operation = {
        ...f.select(method.api, method.member, bytes),
        decode_inner: true,
      };
    const single = await queryNativeRuntime({ operations: [operation] }, f.rpc);
    f.calls.length = 0;
    const finish = vi.spyOn(NativeScaleReader.prototype, "finish");
    const many = await queryNativeRuntime(
      { operations: Array.from({ length: 16 }, () => operation) },
      f.rpc,
    );
    assert.equal(finish.mock.calls.length, 2);
    finish.mockRestore();
    assert.equal(f.calls.length, 1);
    for (const result of many.results)
      assert.equal(JSON.stringify(result), JSON.stringify(single.results[0]));
    assert.notEqual(
      many.results[0]!.inner_result,
      many.results[1]!.inner_result,
    );
    console.log(
      "NATIVE_RESULT_DECODE_REUSE_FIXTURE",
      JSON.stringify({
        format,
        duplicate_operations: 16,
        previous_outer_and_inner_decode_passes: 32,
        decode_passes: 2,
        redundant_decode_passes_removed: 30,
        response_bytes_equal: true,
        separate_public_values: true,
        fixture: true,
        production: false,
      }),
    );
  }
});
