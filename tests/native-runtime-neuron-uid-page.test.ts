import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { Metadata } from "@polkadot/types/metadata";
import { TypeRegistry } from "@polkadot/types/create";
import wrapped, {
  V470_RUNTIME_VERSION,
} from "./fixtures/native-v470-compiled.ts";
import legacyEras from "./fixtures/native-runtime-legacy-compiled.ts";
import modernEras from "./fixtures/native-runtime-eras-compiled.ts";
import { sampleNativeValue } from "./fixtures/native-compiled-values.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  NATIVE_RUNTIME_LIMITS,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeCompact,
  nativeHex,
  nativeStorageKey,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { nativeRuntimeInnerCatalogue } from "../src/native-runtime-inner-catalogue.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { handleNativeRuntime } from "../workers/request-handlers/native-runtime.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

afterEach(() => vi.restoreAllMocks());
const at = `0x${"98".repeat(32)}`;
const api = "NeuronInfoRuntimeApi";

test("compiled v470 singular UID batches serve a collection larger than the bulk wire cap through REST and MCP", async () => {
  const bare = unwrapNativeMetadata(wrapped)!,
    model = decodeNativeMetadata(bare);
  const methods = model.apis.find((row) => row.name === api)!.methods;
  const bulk = methods.find((row) => row.name === "get_neurons")!,
    singular = methods.find((row) => row.name === "get_neuron")!;
  const vector = model.types.get(bulk.output)!.definition;
  assert.equal(vector.kind, "sequence");
  if (vector.kind !== "sequence")
    throw new Error("Expected compiled neuron collection");
  const rows = Array.from({ length: 1024 }, (_, uid) => {
    const sample = sampleNativeValue(model, vector.type);
    assert.ok(
      sample !== null && typeof sample === "object" && !Array.isArray(sample),
    );
    return {
      ...sample,
      uid: String(uid),
      netuid: "19",
      hotkey: `0x${BigInt(uid + 1)
        .toString(16)
        .padStart(64, "0")}`,
      coldkey: `0x${"22".repeat(32)}`,
      active: true,
      validator_permit: true,
      stake: [[`0x${"22".repeat(32)}`, "9007199254740993"]],
      last_update: "9007199254740993",
      weights: Array.from({ length: 32 }, (_, index) => [
        String(index),
        "65535",
      ]),
      bonds: Array.from({ length: 32 }, (_, index) => [String(index), "1"]),
    };
  });
  const bytes = Buffer.concat([
    nativeCompact(BigInt(rows.length)),
    ...rows.map((row) => encodeNativeValue(model, vector.type, row)),
  ]);
  assert.ok(bytes.length > NATIVE_RUNTIME_LIMITS.valueBytes);
  assert.throws(
    () => decodeNativeValue(model, bulk.output, nativeHex(bytes)),
    /oversized/,
  );
  const registry = new TypeRegistry();
  registry.setMetadata(
    new Metadata(registry, Buffer.from(bare.slice(2), "hex")),
  );
  const independent = registry.createTypeUnsafe(`Lookup${bulk.output}`, [
    bytes,
  ]);
  assert.equal(independent.encodedLength, bytes.length);
  assert.equal(nativeHex(independent.toU8a()), nativeHex(bytes));
  const pallet = model.pallets.find((row) => row.name === "SubtensorModule")!,
    count = pallet.storage.find((row) => row.name === "SubnetworkN")!,
    countKey = nativeStorageKey(model, pallet.prefix, count, [19]);
  let executionReads = 0,
    pageBytes = 0,
    missing = false;
  const rpc: BasketRpc = async (name, params) => {
    if (name === "chain_getFinalizedHead") return at;
    if (name === "chain_getHeader") return { number: "0x1f4" };
    if (name === "chain_getBlockHash") return `0x${"94".repeat(32)}`;
    if (name === "state_getRuntimeVersion") return V470_RUNTIME_VERSION;
    if (name === "state_getStorageHash") return `0x${"95".repeat(32)}`;
    if (name === "state_getStorage") {
      assert.deepEqual(params, [countKey, at]);
      return nativeHex(
        encodeNativeValue(model, count.value, String(rows.length)),
      );
    }
    assert.equal(name, "state_call");
    if (params[0] === "Metadata_metadata_at_version") return wrapped;
    if (params[0] === `${api}_get_neurons`) return nativeHex(bytes);
    assert.equal(params[0], `${api}_get_neuron`);
    assert.equal(params[2], at);
    const argumentsBytes = Buffer.from(String(params[1]).slice(2), "hex");
    assert.equal(argumentsBytes.length, 4);
    assert.equal(argumentsBytes.readUInt16LE(0), 19);
    const uid = argumentsBytes.readUInt16LE(2);
    assert.ok(uid < rows.length);
    const value =
      missing && uid === 3
        ? { variant: "None", fields: {} }
        : { variant: "Some", fields: rows[uid]! };
    const encoded = encodeNativeValue(model, singular.output, value);
    const reference = registry.createTypeUnsafe(`Lookup${singular.output}`, [
      encoded,
    ]);
    assert.equal(nativeHex(reference.toU8a()), nativeHex(encoded));
    assert.ok(encoded.length < NATIVE_RUNTIME_LIMITS.valueBytes);
    executionReads++;
    pageBytes += encoded.length;
    return nativeHex(encoded);
  };
  rpc.batch = (calls) => {
    assert.ok(calls.length <= 16);
    return Promise.all(calls.map((call) => rpc(call.method, call.params)));
  };
  const countOperation = {
    kind: "storage",
    pallet: "SubtensorModule",
    member: "SubnetworkN",
    args: [19],
  };
  await assert.rejects(
    queryNativeRuntime(
      {
        operations: [
          { kind: "runtime", api, member: "get_neurons", args: [19] },
        ],
      },
      rpc,
    ),
    /oversized/,
  );
  const countResult = await queryNativeRuntime(
    { operations: [countOperation] },
    rpc,
  );
  assert.equal(countResult.results[0]!.value, "1024");
  const operations = (offset: number) =>
    Array.from({ length: 16 }, (_, index) => ({
      kind: "runtime",
      api,
      member: "get_neuron",
      args: [19, offset + index],
    }));
  const reconstructed: NativeValue[] = [];
  let firstPageBytes = 0;
  for (let offset = 0; offset < rows.length; offset += 16) {
    const before = pageBytes;
    const result = await queryNativeRuntime(
      { as_of: at, operations: operations(offset) },
      rpc,
    );
    assert.equal(result.source.finalized_block_hash, at);
    assert.deepEqual(
      result.results.map((row) => row.value),
      rows
        .slice(offset, offset + 16)
        .map((row) => ({ variant: "Some", fields: row })),
    );
    reconstructed.push(
      ...result.results.map(
        (row) => (row.value as { fields: NativeValue }).fields,
      ),
    );
    if (offset === 0) firstPageBytes = pageBytes - before;
  }
  assert.equal(executionReads, 1024);
  assert.deepEqual(reconstructed, rows);
  missing = true;
  const gap = await queryNativeRuntime(
    { as_of: at, operations: operations(0) },
    rpc,
  );
  assert.deepEqual(gap.results[3]!.value, { variant: "None", fields: {} });
  assert.deepEqual(gap.results[4]!.value, { variant: "Some", fields: rows[4] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const requests = JSON.parse(String(init?.body));
    const reply = async (request: {
      id: unknown;
      method: string;
      params: unknown[];
    }) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: await rpc(request.method, request.params),
    });
    return Response.json(
      Array.isArray(requests)
        ? await Promise.all(requests.map(reply))
        : await reply(requests),
    );
  });
  const env = apiEnv(createLocalArtifactEnv());
  for (const selected of [[countOperation], operations(0)]) {
    const input = { as_of: at, operations: selected };
    const rest = await handleNativeRuntime(
      new Request("https://api.metagraph.sh/api/v1/native-runtime", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    assert.equal(rest.status, 200);
    const envelope = (await rest.json()) as { data: unknown };
    const mcp = await MCP_TOOLS.find(
      (row) => row.name === "get_native_runtime",
    )!.handler(input, { env, clientIp: "192.0.2.1" });
    assert.equal(JSON.stringify(mcp), JSON.stringify(envelope.data));
  }
  console.log(
    "NATIVE_NEURON_UID_PAGE_FIXTURE",
    JSON.stringify({
      runtime_spec: 470,
      source_commit: "923fd1fa7d6eadad3ec16f3941826b86c9c3aa1d",
      neurons: 1024,
      bulk_wire_bytes: bytes.length,
      wire_budget: NATIVE_RUNTIME_LIMITS.valueBytes,
      selected_neurons: 16,
      selected_wire_bytes: firstPageBytes,
      selected_execution_reads: 16,
      all_uid_records_reconstructed: true,
      absence_preserved_without_truncating_later_uids: true,
      rest_mcp_response_bytes_equal: true,
      fixture: true,
      production: false,
    }),
  );
}, 60_000);

for (const release of nativeRuntimeInnerCatalogue)
  test(`compiled legacy spec ${release.spec} singular UID pages preserve both metadata formats and record variants`, async () => {
    const era = legacyEras.find((row) => row.spec === release.spec)!;
    assert.equal(era.commit, release.commit);
    for (const format of [14, 15] as const) {
      const model = decodeNativeMetadata(
          unwrapNativeMetadata(era[`v${format}`])!,
        ),
        inner = {
          ...model,
          types: new Map(release.types.map((type) => [type.id, type])),
        };
      const typed = decodeNativeMetadata(unwrapNativeMetadata(era.v15)!);
      for (const member of ["get_neuron", "get_neuron_lite"]) {
        const signature = typed.apis
          .find((row) => row.name === api)!
          .methods.find((row) => row.name === member)!;
        assert.deepEqual(
          signature.inputs.map((field) => field.name),
          ["netuid", "uid"],
        );
        assert.equal(
          nativeHex(
            Buffer.concat(
              signature.inputs.map((field, index) =>
                encodeNativeValue(typed, field.type, [256, 255][index]!),
              ),
            ),
          ),
          "0x0001ff00",
        );
      }
      const pallet = model.pallets.find(
          (row) => row.name === "SubtensorModule",
        )!,
        count = pallet.storage.find((row) => row.name === "SubnetworkN")!,
        countKey = nativeStorageKey(model, pallet.prefix, count, [256]);
      const calls: unknown[][] = [];
      const rpc: BasketRpc = async (name, params) => {
        if (name === "chain_getFinalizedHead") return at;
        if (name === "chain_getHeader") return { number: "0x1f4" };
        if (name === "chain_getBlockHash") return `0x${"96".repeat(32)}`;
        if (name === "state_getRuntimeVersion") return era.runtimeVersion;
        if (name === "state_getStorageHash")
          return `0x${createHash("sha256").update(`uid:${era.spec}:${format}`).digest("hex")}`;
        if (name === "state_getMetadata") return unwrapNativeMetadata(era.v14);
        if (name === "state_getStorage") {
          assert.deepEqual(params, [countKey, at]);
          return nativeHex(encodeNativeValue(model, count.value, "258"));
        }
        assert.equal(name, "state_call");
        if (params[0] === "Metadata_metadata_at_version")
          return format === 15 ? era.v15 : "0x00";
        const member = String(params[0]).slice(`${api}_`.length),
          method = release.methods.find(
            (row) => row.api === api && row.member === member,
          )!;
        assert.ok(["get_neuron", "get_neuron_lite"].includes(member));
        assert.equal(params[2], at);
        assert.ok(
          ["0x0001ff00", "0x00010001", "0x00010101"].includes(
            String(params[1]),
          ),
        );
        calls.push(params);
        const record = sampleNativeValue(inner, method.root_type);
        const bytes =
          params[1] === "0x00010001"
            ? new Uint8Array()
            : encodeNativeValue(inner, method.root_type, record);
        return nativeHex(
          Buffer.concat([nativeCompact(BigInt(bytes.length)), bytes]),
        );
      };
      rpc.batch = (rows) =>
        Promise.all(rows.map((row) => rpc(row.method, row.params)));
      const total = await queryNativeRuntime(
        {
          operations: [
            {
              kind: "storage",
              pallet: "SubtensorModule",
              member: "SubnetworkN",
              args: [256],
            },
          ],
        },
        rpc,
      );
      assert.equal(total.results[0]!.value, "258");
      for (const member of ["get_neuron", "get_neuron_lite"]) {
        const inputs = ["0x0001ff00", "0x00010001", "0x00010101"];
        const page = await queryNativeRuntime(
          {
            as_of: at,
            operations: inputs.map((input) => ({
              kind: "runtime_scale",
              api,
              member,
              input,
              decode_inner: true,
            })),
          },
          rpc,
        );
        const method = release.methods.find(
          (row) => row.api === api && row.member === member,
        )!;
        assert.deepEqual(
          page.results.map((row) => row.inner_result),
          [
            sampleNativeValue(inner, method.root_type),
            null,
            sampleNativeValue(inner, method.root_type),
          ],
        );
        assert.equal(page.results[1]!.value, "0x00");
        assert.equal(page.source.metadata_version, format);
        assert.equal(page.source.finalized_block_hash, at);
      }
      assert.equal(calls.length, 6);
    }
  });

test("every published structured neuron era binds count and singular full/lite reads to its compiled metadata and independent codec", async () => {
  const eras = [...legacyEras, ...modernEras].filter(
    (era) =>
      !nativeRuntimeInnerCatalogue.some((release) => release.spec === era.spec),
  );
  assert.equal(eras.length, 83);
  for (const era of eras) {
    const bare = unwrapNativeMetadata(era.v15)!,
      model = decodeNativeMetadata(bare);
    const registry = new TypeRegistry();
    registry.setMetadata(
      new Metadata(registry, Buffer.from(bare.slice(2), "hex")),
    );
    const pallet = model.pallets.find((row) => row.name === "SubtensorModule")!,
      count = pallet.storage.find((row) => row.name === "SubnetworkN")!,
      key = nativeStorageKey(model, pallet.prefix, count, [19]);
    let reads = 0;
    const methods = model.apis.find((row) => row.name === api)!.methods;
    const rpc: BasketRpc = async (name, params) => {
      if (name === "chain_getFinalizedHead") return at;
      if (name === "chain_getHeader") return { number: "0x1f4" };
      if (name === "chain_getBlockHash") return `0x${"97".repeat(32)}`;
      if (name === "state_getRuntimeVersion") return era.runtimeVersion;
      if (name === "state_getStorageHash") return `0x${era.wasm_sha256}`;
      if (name === "state_getStorage") {
        assert.deepEqual(params, [key, at]);
        return nativeHex(encodeNativeValue(model, count.value, "2"));
      }
      assert.equal(name, "state_call");
      if (params[0] === "Metadata_metadata_at_version") return era.v15;
      const member = String(params[0]).slice(`${api}_`.length),
        method = methods.find((row) => row.name === member)!;
      assert.ok(["get_neuron", "get_neuron_lite"].includes(member));
      assert.deepEqual(
        method.inputs.map((field) => field.name),
        ["netuid", "uid"],
      );
      assert.equal(params[2], at);
      const uid = String(params[1]) === "0x13000000" ? 0 : 1;
      assert.equal(params[1], uid ? "0x13000100" : "0x13000000");
      const option = model.types.get(method.output)!.definition;
      assert.equal(option.kind, "variant");
      if (option.kind !== "variant")
        throw new Error("Expected compiled neuron Option");
      const some = option.variants.find((variant) => variant.name === "Some")!;
      assert.equal(some.fields.length, 1);
      const record = sampleNativeValue(model, some.fields[0]!.type);
      const value = uid
        ? { variant: "None", fields: {} }
        : { variant: "Some", fields: record };
      const encoded = encodeNativeValue(model, method.output, value);
      assert.equal(
        nativeHex(
          registry
            .createTypeUnsafe(`Lookup${method.output}`, [encoded])
            .toU8a(),
        ),
        nativeHex(encoded),
      );
      reads++;
      return nativeHex(encoded);
    };
    rpc.batch = (calls) =>
      Promise.all(calls.map((call) => rpc(call.method, call.params)));
    const total = await queryNativeRuntime(
      {
        operations: [
          {
            kind: "storage",
            pallet: "SubtensorModule",
            member: "SubnetworkN",
            args: [19],
          },
        ],
      },
      rpc,
    );
    assert.equal(total.results[0]!.value, "2");
    for (const member of ["get_neuron", "get_neuron_lite"]) {
      const output = await queryNativeRuntime(
        {
          as_of: at,
          operations: [0, 1].map((uid) => ({
            kind: "runtime",
            api,
            member,
            args: [19, uid],
          })),
        },
        rpc,
      );
      assert.equal(
        (output.results[0]!.value as { variant: string }).variant,
        "Some",
      );
      assert.deepEqual(output.results[1]!.value, {
        variant: "None",
        fields: {},
      });
      assert.equal(output.source.runtime_spec_version, era.spec);
      assert.equal(output.source.finalized_block_hash, at);
    }
    assert.equal(reads, 4);
  }
}, 120_000);
