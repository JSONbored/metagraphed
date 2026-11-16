import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createNativeAiInference } from "../src/native-ai-inference.ts";
import {
  aiConfigured,
  askQuestion,
  runEmbeddingSync,
  semanticSearch,
  EMBED_MANIFEST_KEY,
  EMBED_MODEL,
  EMBED_DIMENSIONS,
} from "../src/ai-search.ts";
import type { SemanticIndex } from "../src/semantic-index.ts";
import { mockEnv, type Row } from "./row-type.ts";

const owners: ReturnType<typeof createNativeAiInference>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
});
function fixture(
  model = "local-embedding",
  control = new Map<string, string>(),
  indexName = "fixture-index",
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const inference = createNativeAiInference({
    identity: {
      embedding: { provider: "self_hosted", model, dimensions: 3 },
      completion: { provider: "self_hosted", model: "local-answer" },
    },
    embedding: { baseUrl: "http://127.0.0.1:1234/v1/" },
    completion: { baseUrl: "http://127.0.0.1:1234/v1/" },
    maxConcurrent: 2,
    maxRequestBytes: 65536,
    maxResponseBytes: 65536,
    maxOutputTokens: 4096,
    executionTimeoutMillis: 1000,
    drainTimeoutMillis: 1000,
    transport: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      return String(url).endsWith("embeddings")
        ? Response.json({
            data: body.input.map((_: string, index: number) => ({
              index,
              embedding: [1, 0, 0],
            })),
          })
        : Response.json({
            choices: [{ message: { content: "Use Example [1]." } }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          });
    },
  });
  owners.push(inference);
  const vectors = new Map<string, VectorizeVector>();
  const index: SemanticIndex = {
    identity: { name: indexName, model, dimensions: 3 },
    async upsert(entries) {
      for (const entry of entries) vectors.set(entry.id, entry);
      return { mutationId: "fixture" };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "fixture" };
    },
    async query() {
      const matches = [...vectors.values()].map((entry) => ({
        id: entry.id,
        score: 1,
        metadata: entry.metadata,
      }));
      return { count: matches.length, matches };
    },
  };
  const kv = {
    async get(key: string, options?: { type?: string }) {
      const value = control.get(key);
      return value === undefined
        ? null
        : options?.type === "json"
          ? JSON.parse(value)
          : value;
    },
    async put(key: string, value: string) {
      control.set(key, value);
    },
    async delete(key: string) {
      control.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true };
    },
    async consume(key: string) {
      const value = control.get(key) ?? null;
      control.delete(key);
      return value;
    },
  };
  const env = mockEnv({
    AI_INFERENCE: inference,
    SEMANTIC_INDEX: index,
    CONTROL_KV_STORE: kv,
    AI: {
      run() {
        throw new Error("Workers AI must not be called");
      },
    },
    METAGRAPH_AI_GATEWAY: "must-not-be-used",
  });
  const documents = [
    {
      id: "subnet:1",
      type: "subnet",
      netuid: 1,
      title: "Example",
      url: "https://example.com",
    },
  ];
  const readArtifact = async () => ({
    ok: true as const,
    source: "static-assets" as const,
    storage_tier: "static",
    data: { documents },
  });
  return { env, index, inference, calls, control, readArtifact, vectors };
}

test("normal sync, semantic and grounded-answer callers use native inference and native KV", async () => {
  const f = fixture();
  assert.equal(aiConfigured(f.env), true);
  assert.equal(
    (await runEmbeddingSync(f.env, { readArtifact: f.readArtifact })).embedded,
    1,
  );
  assert.equal(
    (await runEmbeddingSync(f.env, { readArtifact: f.readArtifact })).embedded,
    0,
  );
  assert.equal(f.calls.length, 1);
  const found = await semanticSearch(f.env, "Example", { type: "subnet" });
  assert.equal(found.model, "local-embedding");
  assert.equal(found.results[0].title, "Example");
  const answer = await askQuestion(f.env, "Which service?");
  assert.equal(answer.model, "local-answer");
  assert.equal(answer.answer, "Use Example [1].");
  assert.equal(answer.citations.length, 1);
  assert.equal(f.control.size, 1);
  assert.ok([...f.control.keys()][0].startsWith("ai:embed-manifest:native:"));
  assert.equal(f.control.has(EMBED_MANIFEST_KEY), false);
  const prompt = f.calls.find((call) => call.url.endsWith("completions"))!.body;
  assert.equal(prompt.model, "local-answer");
});

test("model changes use distinct synchronization manifests and refuse a mismatched index", async () => {
  const control = new Map<string, string>();
  const first = fixture("model-one", control);
  await runEmbeddingSync(first.env, { readArtifact: first.readArtifact });
  const second = fixture("model-two", control);
  assert.equal(
    (await runEmbeddingSync(second.env, { readArtifact: second.readArtifact }))
      .embedded,
    1,
  );
  assert.equal(control.size, 2);
  const third = fixture("model-two", control, "replacement-index");
  assert.equal(
    (await runEmbeddingSync(third.env, { readArtifact: third.readArtifact }))
      .embedded,
    1,
  );
  assert.equal(control.size, 3);
  const wrong = mockEnv({ ...second.env, SEMANTIC_INDEX: first.index });
  assert.throws(() => aiConfigured(wrong), /identity differs/);
  await assert.rejects(semanticSearch(wrong, "Example"), /identity differs/);
  const unlabelled = { ...second.index, identity: undefined };
  assert.throws(
    () => aiConfigured(mockEnv({ ...second.env, SEMANTIC_INDEX: unlabelled })),
    /identity differs/,
  );
  assert.equal(second.calls.length, 1);
});

test("native removals are durable and malformed selected inference never falls back", async () => {
  const f = fixture();
  await runEmbeddingSync(f.env, { readArtifact: f.readArtifact });
  const result = await runEmbeddingSync(f.env, {
    readArtifact: async () => ({
      ok: true as const,
      source: "static-assets" as const,
      storage_tier: "static",
      data: { documents: [] },
    }),
  });
  assert.equal(result.removed, 1);
  assert.equal(f.vectors.size, 0);
  assert.throws(
    () => aiConfigured(mockEnv({ ...f.env, AI_INFERENCE: {} })),
    /invalid/,
  );
});

test("native inference reports its provider and models without Cloudflare pricing", async () => {
  const f = fixture();
  await runEmbeddingSync(f.env, { readArtifact: f.readArtifact });
  const events: Row[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    events.push(JSON.parse(String(init.body)));
    return new Response("ok");
  });
  await askQuestion(
    mockEnv({ ...f.env, POSTHOG_PROJECT_TOKEN: "fixture-only" }),
    "Which service?",
  );
  assert.equal(events.length, 2);
  for (const event of events)
    assert.equal(event.properties.$ai_provider, "self_hosted");
  assert.equal(
    events.find((event) => event.event === "$ai_embedding")!.properties
      .$ai_model,
    "local-embedding",
  );
  const generation = events.find((event) => event.event === "$ai_generation")!;
  assert.equal(generation.properties.$ai_model, "local-answer");
  assert.equal(generation.properties.$ai_total_cost_usd, undefined);
});

test("storage remains required and existing Vectorize requires its original embedding identity", async () => {
  const f = fixture();
  assert.equal(aiConfigured(mockEnv({ AI_INFERENCE: f.inference })), false);
  const legacyModel = {
    ...f.inference,
    identity: {
      ...f.inference.identity,
      embedding: {
        provider: "self_hosted",
        model: EMBED_MODEL,
        dimensions: EMBED_DIMENSIONS,
      },
    },
  };
  const env = mockEnv({ AI_INFERENCE: legacyModel, VECTORIZE: {} });
  assert.equal(aiConfigured(env), true);
  assert.equal(
    (
      await runEmbeddingSync(env, {
        readArtifact: async () => ({
          ok: true as const,
          source: "static-assets" as const,
          storage_tier: "static",
          data: { documents: [] },
        }),
      })
    ).embedded,
    0,
  );
  assert.throws(
    () => aiConfigured(mockEnv({ AI_INFERENCE: f.inference, VECTORIZE: {} })),
    /identity differs/,
  );
  assert.throws(
    () =>
      aiConfigured(
        mockEnv({
          ...f.env,
          SEMANTIC_INDEX: {
            ...f.index,
            identity: { ...f.index.identity, name: "" },
          },
        }),
      ),
    /identity differs/,
  );
});

test("native malformed embeddings and completion failures retain normal application errors", async () => {
  const f = fixture();
  const malformed = mockEnv({
    ...f.env,
    AI_INFERENCE: { ...f.inference, embed: async () => ({ data: [[1]] }) },
  });
  assert.equal(
    (await runEmbeddingSync(malformed, { readArtifact: f.readArtifact }))
      .embedded,
    0,
  );
  await assert.rejects(semanticSearch(malformed, "Example"), /no vector/);
  await runEmbeddingSync(f.env, { readArtifact: f.readArtifact });
  const failing = mockEnv({
    ...f.env,
    AI_INFERENCE: {
      ...f.inference,
      complete: async () => {
        throw new Error("local model failed");
      },
    },
  });
  await assert.rejects(askQuestion(failing, "Example"), /local model failed/);
});

test("request execution signals reach both native model operations", async () => {
  const f = fixture();
  await runEmbeddingSync(f.env, { readArtifact: f.readArtifact });
  const controller = new AbortController();
  const signals: (AbortSignal | undefined)[] = [];
  const inference = {
    ...f.inference,
    embed(text: readonly string[], signal?: AbortSignal) {
      signals.push(signal);
      return f.inference.embed(text, signal);
    },
    complete(
      messages: Parameters<typeof f.inference.complete>[0],
      maxTokens: number,
      signal?: AbortSignal,
    ) {
      signals.push(signal);
      return f.inference.complete(messages, maxTokens, signal);
    },
  };
  await askQuestion(
    mockEnv({ ...f.env, AI_INFERENCE: inference }),
    "Example",
    {},
    { executionCtx: { signal: controller.signal } },
  );
  assert.deepEqual(signals, [controller.signal, controller.signal]);
});
