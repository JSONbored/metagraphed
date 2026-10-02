import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import {
  NativeRuntimeRequestSchema,
  NativeCodeArtifactSchema,
} from "../schemas-src/routes/native-runtime.ts";
import { resolveNativeCodeArtifacts } from "../src/native-code-artifact.ts";
import type { NativeMetadata } from "../src/native-runtime-metadata.ts";

const url = `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/code.wasm`;
const data = Buffer.alloc(131_072, 0xa5);
const artifact = {
  url,
  bytes: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
};
const operations = (rows: unknown[]) =>
  NativeRuntimeRequestSchema.parse({ operations: rows }).operations;
const operation = () => ({
  kind: "runtime",
  api: "ContractsApi",
  member: "upload_code",
  args: ["0x"],
  code_artifact: artifact,
});
function model(): NativeMetadata {
  return {
    version: 15,
    extrinsicVersion: 4,
    signedExtensions: [],
    types: new Map([
      [0, { id: 0, path: [], definition: { kind: "primitive", primitive: 3 } }],
      [1, { id: 1, path: [], definition: { kind: "primitive", primitive: 5 } }],
      [2, { id: 2, path: [], definition: { kind: "sequence", type: 0 } }],
      [
        3,
        {
          id: 3,
          path: [],
          definition: {
            kind: "variant",
            variants: [
              { name: "Upload", index: 0, fields: [{ name: null, type: 2 }] },
              { name: "Existing", index: 1, fields: [{ name: null, type: 4 }] },
            ],
          },
        },
      ],
      [
        4,
        { id: 4, path: [], definition: { kind: "array", type: 0, length: 32 } },
      ],
      [
        5,
        {
          id: 5,
          path: [],
          definition: {
            kind: "composite",
            fields: [
              { name: "ref_time", type: 6 },
              { name: "proof_size", type: 6 },
            ],
          },
        },
      ],
      [6, { id: 6, path: [], definition: { kind: "primitive", primitive: 6 } }],
      [
        7,
        {
          id: 7,
          path: [],
          definition: {
            kind: "variant",
            variants: [
              { name: "None", index: 0, fields: [] },
              { name: "Some", index: 1, fields: [{ name: null, type: 5 }] },
            ],
          },
        },
      ],
      [
        8,
        {
          id: 8,
          path: [],
          definition: {
            kind: "variant",
            variants: [
              {
                name: "upload_code",
                index: 0,
                fields: [{ name: "code", type: 2 }],
              },
              {
                name: "instantiate_with_code",
                index: 1,
                fields: [
                  { name: "gas_limit", type: 5 },
                  { name: "code", type: 2 },
                ],
              },
            ],
          },
        },
      ],
    ]),
    pallets: [
      {
        name: "Contracts",
        prefix: "Contracts",
        index: 29,
        calls: 8,
        storage: [],
        constants: [{ name: "MaxCodeLen", type: 1, value: "0x00000200" }],
      },
    ],
    apis: [
      {
        name: "ContractsApi",
        methods: [
          {
            name: "upload_code",
            inputs: [{ name: "code", type: 2 }],
            output: 1,
          },
          {
            name: "instantiate",
            inputs: [
              { name: "gas_limit", type: 7 },
              { name: "code", type: 3 },
            ],
            output: 1,
          },
        ],
      },
    ],
  };
}
const weight = { ref_time: "100000000000", proof_size: "32768" };

function fetcher(response: () => Response = () => new Response(data)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("artifact-free requests preserve operations and argument identity without a fetch", async () => {
  const input = operations([
    { kind: "describe", pallet: "Contracts" },
    {
      kind: "runtime",
      api: "ContractsApi",
      member: "upload_code",
      args: ["0x00"],
    },
  ]);
  const f = fetcher();
  assert.strictEqual(
    await resolveNativeCodeArtifacts(model(), input, f.fetchImpl),
    input,
  );
  assert.equal(f.calls.length, 0);
});

test("full code artifacts bind exact bytes only to their declared arguments, coalesce and preserve input", async () => {
  const input = operations([
    { kind: "constant", pallet: "Contracts", member: "MaxCodeLen" },
    operation(),
    operation(),
  ]);
  const f = fetcher(
    () =>
      new Response(data, {
        headers: { "content-length": String(data.length) },
      }),
  );
  const result = await resolveNativeCodeArtifacts(model(), input, f.fetchImpl);
  assert.strictEqual(result[0], input[0]);
  for (const row of result.slice(1)) {
    assert.equal(row.kind, "runtime");
    if (row.kind !== "runtime") continue;
    assert.deepEqual(row.args, [`0x${data.toString("hex")}`]);
    assert.deepEqual(row.code_artifact, artifact);
  }
  assert.deepEqual(
    input,
    operations([
      { kind: "constant", pallet: "Contracts", member: "MaxCodeLen" },
      operation(),
      operation(),
    ]),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, url);
  assert.equal(f.calls[0]!.init!.redirect, "manual");
  assert.deepEqual(f.calls[0]!.init!.headers, {
    accept: "application/octet-stream",
  });
  assert.ok(f.calls[0]!.init!.signal instanceof AbortSignal);
});

test("runtime Upload enums and native full-code preparation preserve all other arguments", async () => {
  const input = operations([
    {
      kind: "runtime",
      api: "ContractsApi",
      member: "instantiate",
      args: [
        { variant: "Some", fields: weight },
        { variant: "Upload", fields: "0x" },
      ],
      code_artifact: artifact,
    },
    {
      kind: "prepare",
      pallet: "Contracts",
      member: "instantiate_with_code",
      args: [weight, "0x"],
      code_artifact: artifact,
    },
    {
      kind: "prepare",
      pallet: "Contracts",
      member: "upload_code",
      args: ["0x"],
      code_artifact: artifact,
    },
  ]);
  const f = fetcher();
  const result = await resolveNativeCodeArtifacts(model(), input, f.fetchImpl);
  assert.equal(f.calls.length, 1);
  assert.equal(result[0]!.kind, "runtime");
  assert.equal(result[1]!.kind, "prepare");
  if (
    result[0]!.kind !== "runtime" ||
    result[1]!.kind !== "prepare" ||
    result[2]!.kind !== "prepare"
  )
    return;
  assert.deepEqual(result[0]!.args, [
    { variant: "Some", fields: weight },
    { variant: "Upload", fields: `0x${data.toString("hex")}` },
  ]);
  assert.deepEqual(result[1]!.args, [weight, `0x${data.toString("hex")}`]);
  assert.deepEqual(result[2]!.args, [`0x${data.toString("hex")}`]);
});

test("invalid or mutable artifact origins and descriptors reject before any fetch", async () => {
  for (const bad of [
    "not a URL",
    url.replace("https:", "http:"),
    url.replace("raw.githubusercontent.com", "example.com"),
    url.replace("https://", "https://x@"),
    url.replace("https://", "https://x:y@"),
    url.replace("raw.githubusercontent.com", "raw.githubusercontent.com:444"),
    url + "?raw=1",
    url + "#fragment",
    url.replace("a".repeat(40), "main"),
    url.replace("a".repeat(40), "a".repeat(39)),
    url.replace("code.wasm", "code%2ewasm"),
  ]) {
    const f = fetcher();
    await assert.rejects(async () =>
      resolveNativeCodeArtifacts(
        model(),
        operations([
          { ...operation(), code_artifact: { ...artifact, url: bad } },
        ]),
        f.fetchImpl,
      ),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const bad of [
    { ...artifact, bytes: 131073 },
    { ...artifact, bytes: 0 },
    { ...artifact, sha256: "00" },
    { ...artifact, extra: true },
  ]) {
    assert.throws(() => NativeCodeArtifactSchema.parse(bad));
  }
});

test("metadata, source code size, arity and exact placeholder failures reject before fetching", async () => {
  const cases: { mutate?: (meta: NativeMetadata) => void; row?: unknown }[] = [
    {
      mutate: (m) => {
        m.pallets = [];
      },
    },
    {
      mutate: (m) => {
        m.pallets[0]!.constants = [];
      },
    },
    {
      mutate: (m) => {
        m.types.get(1)!.definition = { kind: "primitive", primitive: 0 };
        m.pallets[0]!.constants[0]!.value = "0x00";
      },
    },
    {
      mutate: (m) => {
        m.pallets[0]!.constants[0]!.type = 2;
        m.pallets[0]!.constants[0]!.value = "0x00";
      },
    },
    {
      mutate: (m) => {
        m.pallets[0]!.constants[0]!.value = "0x01000000";
      },
    },
    {
      mutate: (m) => {
        m.apis = [];
      },
    },
    {
      mutate: (m) => {
        m.apis[0]!.methods = [];
      },
    },
    {
      mutate: (m) => {
        m.apis[0]!.methods[0]!.inputs[0]!.name = null;
      },
    },
    {
      mutate: (m) => {
        m.apis[0]!.methods[0]!.inputs.push({ name: "code", type: 2 });
      },
      row: { ...operation(), args: ["0x", "0x"] },
    },
    {
      mutate: (m) => {
        m.types.get(2)!.definition = { kind: "array", type: 0, length: 0 };
      },
    },
    {
      mutate: (m) => {
        m.types.get(2)!.definition = { kind: "sequence", type: 1 };
      },
    },
    {
      mutate: (m) => {
        m.types.delete(2);
      },
    },
    {
      mutate: (m) => {
        m.types.delete(0);
      },
    },
    { row: { ...operation(), args: [] } },
    { row: { ...operation(), args: ["0x", "0x"] } },
    { row: { ...operation(), args: ["0x00"] } },
    { row: { ...operation(), api: "Other" } },
    { row: { ...operation(), member: "call" } },
    {
      row: {
        kind: "prepare",
        pallet: "Contracts",
        member: "unknown",
        args: [],
        code_artifact: artifact,
      },
    },
    {
      row: {
        kind: "prepare",
        pallet: "Other",
        member: "upload_code",
        args: ["0x"],
        code_artifact: artifact,
      },
    },
    {
      mutate: (m) => {
        m.pallets[0]!.calls = null;
      },
      row: {
        kind: "prepare",
        pallet: "Contracts",
        member: "upload_code",
        args: ["0x"],
        code_artifact: artifact,
      },
    },
    {
      mutate: (m) => {
        m.types.get(8)!.definition = { kind: "tuple", types: [] };
      },
      row: {
        kind: "prepare",
        pallet: "Contracts",
        member: "upload_code",
        args: ["0x"],
        code_artifact: artifact,
      },
    },
    {
      row: {
        kind: "runtime",
        api: "ContractsApi",
        member: "instantiate",
        args: [
          { variant: "None", fields: {} },
          { variant: "Upload", fields: "0x" },
        ],
        code_artifact: artifact,
      },
    },
  ];
  for (const item of cases) {
    const meta = model();
    item.mutate?.(meta);
    const f = fetcher();
    await assert.rejects(async () =>
      resolveNativeCodeArtifacts(
        meta,
        operations([item.row ?? operation()]),
        f.fetchImpl,
      ),
    );
    assert.equal(f.calls.length, 0);
  }
  const instantiate = {
    kind: "runtime",
    api: "ContractsApi",
    member: "instantiate",
    args: [
      { variant: "Some", fields: weight },
      { variant: "Upload", fields: "0x" },
    ],
    code_artifact: artifact,
  };
  for (const code of [
    null,
    [],
    "0x",
    { variant: "Existing", fields: "0x" },
    { variant: "Upload", fields: "0x01" },
    { variant: "Upload", fields: "0x", extra: 1 },
  ]) {
    const f = fetcher();
    await assert.rejects(() =>
      resolveNativeCodeArtifacts(
        model(),
        operations([{ ...instantiate, args: [instantiate.args[0], code] }]),
        f.fetchImpl,
      ),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const change of [
    "missing",
    "named",
    "multiple",
    "wrong bytes",
  ] as const) {
    const meta = model();
    const def = meta.types.get(3)!.definition;
    assert.equal(def.kind, "variant");
    if (def.kind !== "variant") continue;
    const upload = def.variants[0]!;
    if (change === "missing") def.variants = [];
    if (change === "named") upload.fields[0]!.name = "code";
    if (change === "multiple") upload.fields.push({ name: null, type: 2 });
    if (change === "wrong bytes") upload.fields[0]!.type = 4;
    const f = fetcher();
    await assert.rejects(() =>
      resolveNativeCodeArtifacts(meta, operations([instantiate]), f.fetchImpl),
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fetcher();
  await assert.rejects(
    () =>
      resolveNativeCodeArtifacts(
        model(),
        operations([
          operation(),
          {
            ...operation(),
            code_artifact: {
              ...artifact,
              url: url.replace("code.wasm", "other.wasm"),
            },
          },
        ]),
        f.fetchImpl,
      ),
    /one distinct/,
  );
  assert.equal(f.calls.length, 0);
});

test("artifact streams enforce exact declared and actual bytes, checksum, status and bounded chunks", async () => {
  const responses = [
    () => new Response("redirect", { status: 302, headers: { location: url } }),
    () => new Response("missing", { status: 404 }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { headers: { "content-length": "131073" } }),
    () => new Response(null, { status: 204 }),
    ...["unknown", "-1", "131071", "131073"].map(
      (length) => () =>
        new Response(data, { headers: { "content-length": length } }),
    ),
    () =>
      new Response(data, {
        headers: { "content-length": "262145", "content-encoding": "gzip" },
      }),
    () => new Response(data.subarray(0, data.length - 1)),
    () => new Response(Buffer.alloc(data.length + 1)),
    () => new Response(Buffer.alloc(data.length)),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array());
            controller.close();
          },
        }),
      ),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("fixture stream read failure"));
          },
        }),
      ),
  ];
  for (const response of responses) {
    const f = fetcher(response);
    await assert.rejects(() =>
      resolveNativeCodeArtifacts(
        model(),
        operations([operation()]),
        f.fetchImpl,
      ),
    );
    assert.equal(f.calls.length, 1);
  }
  // A compressed transfer can declare fewer bytes than its decoded body.
  // Admission and the checksum always use the exact bytes read from the body.
  const transfer = fetcher(
    () =>
      new Response(data, {
        headers: { "content-length": "1000", "content-encoding": "gzip" },
      }),
  );
  await resolveNativeCodeArtifacts(
    model(),
    operations([operation()]),
    transfer.fetchImpl,
  );
  const identity = fetcher(
    () =>
      new Response(data, {
        headers: { "content-length": "131072", "content-encoding": "identity" },
      }),
  );
  await resolveNativeCodeArtifacts(
    model(),
    operations([operation()]),
    identity.fetchImpl,
  );
  const chunked = fetcher(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(data.subarray(0, 100));
            controller.enqueue(data.subarray(100));
            controller.close();
          },
        }),
      ),
  );
  const result = await resolveNativeCodeArtifacts(
    model(),
    operations([operation()]),
    chunked.fetchImpl,
  );
  assert.equal(result[0]!.kind, "runtime");
  if (result[0]!.kind === "runtime")
    assert.deepEqual(result[0]!.args, [`0x${data.toString("hex")}`]);
});

test("artifact deadlines bound stalled bodies and late headers, cancelling their reader", async () => {
  for (const early of [false, true]) {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    let cancelled = 0;
    if (early) controller.abort();
    const f = fetcher(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              if (!early) queueMicrotask(() => controller.abort());
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
    );
    try {
      await assert.rejects(
        () =>
          resolveNativeCodeArtifacts(
            model(),
            operations([operation()]),
            f.fetchImpl,
          ),
        /timed out/,
      );
      assert.equal(cancelled, 1);
    } finally {
      timeout.mockRestore();
    }
  }
});


function evmModel(): NativeMetadata {
  const meta=model();
  meta.pallets=[{...meta.pallets[0]!,name:"EVM",prefix:"EVM",constants:[]}];
  meta.apis=[{name:"EthereumRuntimeRPCApi",methods:[{name:"create",inputs:[{name:"data",type:2},{name:"gas_limit",type:6}],output:1}]}];
  meta.types.get(8)!.definition={kind:"variant",variants:[{name:"create",index:2,fields:[{name:"init",type:2}]},{name:"create2",index:3,fields:[{name:"init",type:2}]}]};
  return meta;
}

test("EVM creation artifacts bind only declared init/data bytes and reject gas or incompatible calls before fetching", async () => {
  const create={kind:"runtime",api:"EthereumRuntimeRPCApi",member:"create",args:["0x","500000"],code_artifact:artifact};
  for(const row of [create,{kind:"prepare",pallet:"EVM",member:"create",args:["0x"],code_artifact:artifact},{kind:"prepare",pallet:"EVM",member:"create2",args:["0x"],code_artifact:artifact}]) {
    const f=fetcher();const result=await resolveNativeCodeArtifacts(evmModel(),operations([row,row]),f.fetchImpl);
    assert.equal(f.calls.length,1);assert.equal((result[0] as {args:unknown[]}).args[0],`0x${data.toString("hex")}`);
    assert.deepEqual(result[0],result[1]);assert.equal(row.args[0],"0x");
  }
  const cases:{row?:unknown;mutate?:(meta:NativeMetadata)=>void}[]=[
    ...["0","1000001",["1","1","0","0"],null,"01"].map(gas=>({row:{...create,args:["0x",gas]}})),
    {row:{...create,evm_call:{signature:"x()",args:[]}}},
    {row:{...create,args:["0x00","500000"]}},
    {row:{...create,args:["0x", "500000", 0]}},
    {row:{...create,member:"call"}},
    {row:{kind:"prepare",pallet:"EVM",member:"call",args:["0x"],code_artifact:artifact}},
    {mutate:meta=>{meta.pallets=[];}},
    {mutate:meta=>{meta.apis[0]!.methods=[];}},
    {mutate:meta=>{meta.apis[0]!.methods[0]!.inputs[0]!.name="code";}},
    {mutate:meta=>{meta.apis[0]!.methods[0]!.inputs[0]!.type=3;}},
    {mutate:meta=>{meta.apis[0]!.methods[0]!.inputs[1]!.name="unknown";}},
    {mutate:meta=>{meta.apis[0]!.methods[0]!.inputs.push({name:"gas_limit",type:6});}},
    {mutate:meta=>{meta.types.get(8)!.definition={kind:"variant",variants:[]};},row:{kind:"prepare",pallet:"EVM",member:"create",args:["0x"],code_artifact:artifact}},
  ];
  for(const item of cases) {
    const meta=evmModel();item.mutate?.(meta);const f=fetcher();
    await assert.rejects(()=>resolveNativeCodeArtifacts(meta,operations([item.row??create]),f.fetchImpl));
    assert.equal(f.calls.length,0);
  }
});
