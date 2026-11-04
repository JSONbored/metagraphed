import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createNativeAiInference,
  type NativeInferenceOptions,
} from "../src/native-ai-inference.ts";
import { selectedAiInference } from "../src/ai-inference.ts";

const options: NativeInferenceOptions = {
  identity: {
    embedding: {
      provider: "self_hosted",
      model: "fixture-embed",
      dimensions: 3,
    },
    completion: { provider: "self_hosted", model: "fixture-chat" },
  },
  embedding: { baseUrl: "http://127.0.0.1:1234/v1", token: "fixture-token" },
  completion: { baseUrl: "http://127.0.0.1:5678/v1/" },
  maxConcurrent: 2,
  maxRequestBytes: 4096,
  maxResponseBytes: 4096,
  maxOutputTokens: 256,
  executionTimeoutMillis: 1000,
  drainTimeoutMillis: 1000,
};
const completion = () =>
  Response.json({
    choices: [{ message: { content: "answer [1]" } }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  });
const embedding = () =>
  Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
const owners: ReturnType<typeof createNativeAiInference>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
});
function create(
  transport: typeof fetch = async () => embedding(),
  overrides: Partial<NativeInferenceOptions> = {},
) {
  const owner = createNativeAiInference({
    ...options,
    ...overrides,
    transport,
  });
  owners.push(owner);
  return owner;
}

test("selects only complete explicit inference capabilities", () => {
  for (const env of [undefined, null, 1, {}, { AI_INFERENCE: undefined }])
    assert.equal(selectedAiInference(env), undefined);
  const owner = create();
  assert.equal(selectedAiInference({ AI_INFERENCE: owner }), owner);
  for (const value of [null, {}, { embed() {} }, { embed() {}, complete() {} }])
    assert.throws(() => selectedAiInference({ AI_INFERENCE: value }));
});

test("uses fixed endpoints, credentials and model identity with bounded nonstreaming payloads", async () => {
  const calls: { url: string; input: RequestInit }[] = [];
  const owner = create(async (url, init) => {
    calls.push({ url: String(url), input: init! });
    return calls.length === 1 ? embedding() : completion();
  });
  assert.deepEqual(await owner.embed(["hello"]), { data: [[1, 0, 0]] });
  assert.deepEqual(
    await owner.complete([{ role: "user", content: "question" }], 64),
    {
      response: "answer [1]",
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    },
  );
  assert.equal(calls[0].url, "http://127.0.0.1:1234/v1/embeddings");
  assert.equal(calls[1].url, "http://127.0.0.1:5678/v1/chat/completions");
  assert.equal(
    new Headers(calls[0].input.headers).get("authorization"),
    "Bearer fixture-token",
  );
  assert.equal(new Headers(calls[1].input.headers).get("authorization"), null);
  assert.equal(calls[0].input.redirect, "manual");
  assert.deepEqual(JSON.parse(String(calls[0].input.body)), {
    model: "fixture-embed",
    input: ["hello"],
    encoding_format: "float",
  });
  assert.equal(JSON.parse(String(calls[1].input.body)).stream, false);
  assert.equal(JSON.parse(String(calls[1].input.body)).max_tokens, 64);
});

test("validates identity, resource bounds and endpoints before any request", () => {
  for (const override of [
    { maxConcurrent: 0 },
    { maxConcurrent: 101 },
    { maxRequestBytes: 0 },
    { maxResponseBytes: 33554433 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 4097 },
    { executionTimeoutMillis: 0 },
    { maxConcurrent: 100, maxResponseBytes: 1048576 },
    {
      identity: {
        ...options.identity,
        embedding: { ...options.identity.embedding, dimensions: 0 },
      },
    },
    { embedding: { baseUrl: "file:///secret" } },
    { embedding: { baseUrl: "https://user:password@example.invalid/v1" } },
    { embedding: { baseUrl: "http://example.invalid/v1?model=x" } },
    { embedding: { baseUrl: "http://example.invalid/v1#secret" } },
    { embedding: { baseUrl: "http://example.invalid/v1", token: "" } },
    { embedding: { baseUrl: "http://example.invalid/v1", token: "x\ny" } },
  ])
    assert.throws(() => createNativeAiInference({ ...options, ...override }));
  assert.throws(
    () =>
      createNativeAiInference({ ...options, transport: {} as typeof fetch }),
    /transport/,
  );
});

test("rejects invalid or oversized inputs before dispatch", async () => {
  const owner = create(async () => {
    throw new Error("must not dispatch");
  });
  for (const value of [
    [],
    Array(101).fill("x"),
    [1],
    Array(1),
    ["x".repeat(4097)],
  ])
    await assert.rejects(owner.embed(value as string[]), /input|budget/);
  await assert.rejects(owner.embed(["\0".repeat(1000)]), /budget/);
  for (const value of [[], Array(101).fill({ role: "user", content: "x" })])
    await assert.rejects(owner.complete(value, 1), /entries/);
  await assert.rejects(
    owner.complete([{ role: "tool" as "user", content: "x" }], 1),
  );
  await assert.rejects(
    owner.complete([{ role: "user", content: "x".repeat(4097) }], 1),
    /budget/,
  );
  for (const value of [0, 257, 1.5])
    await assert.rejects(
      owner.complete([{ role: "user", content: "x" }], value),
      /budget/,
    );
});

test("validates and reorders complete embedding batches", async () => {
  const owner = create(async () =>
    Response.json({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
    }),
  );
  assert.deepEqual(await owner.embed(["one", "two"]), {
    data: [
      [1, 0, 0],
      [0, 1, 0],
    ],
  });
  for (const data of [
    [],
    [{ index: 1, embedding: [1, 0, 0] }],
    [{ index: 0, embedding: [1] }],
    [
      { index: 0, embedding: [1, 0, 0] },
      { index: 0, embedding: [1, 0, 0] },
    ],
  ]) {
    const bad = create(async () => Response.json({ data }));
    await assert.rejects(
      bad.embed(data.length === 2 ? ["one", "two"] : ["one"]),
      /count|shape/,
    );
  }
});

test("refuses malformed HTTP and JSON bodies without exposing provider payloads", async () => {
  for (const response of [
    new Response("sensitive body", { status: 429 }),
    new Response(null),
    new Response("{}", { headers: { "content-length": "not-a-length" } }),
    new Response("{}", { headers: { "content-length": "4097" } }),
    new Response("x".repeat(4097)),
    new Response("not JSON"),
    new Response(new Uint8Array([255])),
  ]) {
    const owner = create(async () => response);
    await assert.rejects(
      owner.embed(["one"]),
      (error: Error) => !error.message.includes("sensitive body"),
    );
  }
  const owner = create(async () =>
    Response.json({ choices: [{ message: { content: "answer" } }] }),
  );
  assert.deepEqual(await owner.complete([{ role: "user", content: "x" }], 1), {
    response: "answer",
  });
  const invalid = create(async () => Response.json({ choices: [] }));
  await assert.rejects(invalid.complete([{ role: "user", content: "x" }], 1));
});

test("snapshots endpoint and identity configuration", async () => {
  const settings = structuredClone(options);
  const owner = createNativeAiInference({
    ...settings,
    transport: async (url) => {
      assert.equal(String(url), "http://127.0.0.1:1234/v1/embeddings");
      return embedding();
    },
  });
  owners.push(owner);
  settings.identity.embedding.model = "changed";
  settings.embedding.baseUrl = "http://127.0.0.1:9";
  assert.equal(owner.identity.embedding.model, "fixture-embed");
  assert.deepEqual(await owner.embed(["x"]), { data: [[1, 0, 0]] });
  await owner.close();
  assert.equal(owner.state, "closed");
  await assert.rejects(owner.embed(["x"]), /closed/);
});

test("bounds chunked and empty-chunk responses while yielding deadline checks", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 130; i++) controller.enqueue(new Uint8Array());
      controller.enqueue(encoded.subarray(0, 10));
      controller.enqueue(encoded.subarray(10));
      controller.close();
    },
  });
  assert.deepEqual(
    await create(async () => new Response(stream)).embed(["x"]),
    { data: [[1, 0, 0]] },
  );
  let cancelled = false;
  const empty = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    create(async () => new Response(empty), { maxResponseBytes: 2 }).embed([
      "x",
    ]),
    /byte budget/,
  );
  assert.equal(cancelled, true);
});

test("deadlines preserve admission until an uncooperative transport really finishes", async () => {
  vi.useFakeTimers();
  let release!: (value: Response) => void;
  const blocked = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const owner = create(async () => blocked, {
    maxConcurrent: 1,
    executionTimeoutMillis: 10,
    drainTimeoutMillis: 5,
  });
  const pending = owner.embed(["x"]);
  const failed = assert.rejects(pending, /execution deadline/);
  await vi.advanceTimersByTimeAsync(0);
  await assert.rejects(owner.embed(["other"]), /capacity/);
  await vi.advanceTimersByTimeAsync(10);
  await failed;
  await assert.rejects(owner.embed(["still pending"]), /capacity/);
  const closing = assert.rejects(owner.close(), /drain deadline/);
  await vi.advanceTimersByTimeAsync(5);
  await closing;
  assert.equal(owner.state, "closing");
  release(embedding());
  await vi.advanceTimersByTimeAsync(0);
  await owner.close();
  assert.equal(owner.state, "closed");
});

test("cleanup rejection cannot replace a size or wire error", async () => {
  const oversized = new ReadableStream<Uint8Array>({
    cancel() {
      return Promise.reject(new Error("cancel rejected"));
    },
  });
  await assert.rejects(
    create(
      async () =>
        new Response(oversized, { headers: { "content-length": "5000" } }),
    ).embed(["x"]),
    /byte budget/,
  );
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("wire failed"));
    },
  });
  await assert.rejects(
    create(async () => new Response(broken)).embed(["x"]),
    /wire failed/,
  );
  await Promise.resolve();
  await assert.rejects(
    create(async () => new Response("provider-secret-in-body")).embed(["x"]),
    (error: Error) =>
      error.message === "Inference endpoint returned invalid JSON",
  );
});

test("a stalled body is cancelled at the execution deadline even if cancellation rejects", async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      cancelled = true;
      return Promise.reject(new Error("cancel rejected"));
    },
  });
  const owner = create(async () => new Response(stream), {
    executionTimeoutMillis: 10,
  });
  const failed = assert.rejects(owner.embed(["x"]), /execution deadline/);
  await vi.advanceTimersByTimeAsync(10);
  await failed;
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(cancelled, true);
  await owner.close();
});

test("caller cancellation stops admission before fetch and cancels an active body", async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("caller left"));
  let called = 0;
  const immediate = create(async () => {
    called++;
    return embedding();
  });
  await assert.rejects(immediate.embed(["x"], aborted.signal), /caller left/);
  assert.equal(called, 0);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let cancelled = false;
  const controller = new AbortController();
  const active = create(async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        began();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream);
  });
  const pending = active.embed(["x"], controller.signal);
  const rejected = assert.rejects(pending, /caller disconnected/);
  await started;
  controller.abort(new Error("caller disconnected"));
  await rejected;
  assert.equal(cancelled, true);
});
