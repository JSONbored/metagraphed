import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test, vi } from "vitest";

// Keep native networking independent of Worker files' shared module mocks.
vi.resetModules();
const { createNativeAiInference } =
  await import("../src/native-ai-inference.ts");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("native inference exchanges real bounded HTTP requests without redirects or Worker bindings", async () => {
  const requests: {
    path: string;
    auth: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body);
    requests.push({
      path: request.url!,
      auth: request.headers.authorization,
      body: parsed,
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url!.endsWith("embeddings")
          ? { data: [{ index: 0, embedding: [0.5, 1, 0] }] }
          : {
              choices: [{ message: { content: "local answer" } }],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1/`;
  const owner = createNativeAiInference({
    identity: {
      embedding: {
        provider: "self_hosted",
        model: "fixture-embedding",
        dimensions: 3,
      },
      completion: { provider: "self_hosted", model: "fixture-answer" },
    },
    embedding: { baseUrl, token: "fixture-only" },
    completion: { baseUrl },
    maxConcurrent: 1,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
    maxOutputTokens: 64,
    executionTimeoutMillis: 2000,
    drainTimeoutMillis: 2000,
  });
  cleanup.push(() => owner.close());
  assert.deepEqual(await owner.embed(["hello"]), { data: [[0.5, 1, 0]] });
  assert.equal(
    (await owner.complete([{ role: "user", content: "hello" }], 20)).response,
    "local answer",
  );
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/v1/embeddings", "/v1/chat/completions"],
  );
  assert.equal(requests[0].auth, "Bearer fixture-only");
  assert.equal(requests[1].auth, undefined);
  assert.equal(requests[0].body.model, "fixture-embedding");
  assert.equal(requests[1].body.stream, false);
});
