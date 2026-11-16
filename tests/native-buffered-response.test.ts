import assert from "node:assert/strict";
import { test } from "vitest";
import { bufferNativeResponse } from "../src/native-buffered-response.ts";

test("native response buffering preserves bytes, status and headers", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
        controller.enqueue(new Uint8Array([128, 10]));
        controller.close();
      },
    }),
    { status: 201, statusText: "Created", headers: { "x-fixture": "kept" } },
  );
  const result = await bufferNativeResponse(
    response,
    new AbortController().signal,
    4,
  );
  assert.equal(result.status, 201);
  assert.equal(result.statusText, "Created");
  assert.equal(result.headers.get("x-fixture"), "kept");
  assert.deepEqual(
    new Uint8Array(await result.arrayBuffer()),
    new Uint8Array([0, 255, 128, 10]),
  );
  const empty = await bufferNativeResponse(
    new Response(null, { status: 204 }),
    new AbortController().signal,
    4,
  );
  assert.equal(empty.body, null);
});

test("native response buffering refuses byte and empty-chunk bombs", async () => {
  await assert.rejects(
    bufferNativeResponse(new Response("abc"), new AbortController().signal, 2),
    /byte budget/,
  );
  let cancelled = 0;
  const endless = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  await assert.rejects(
    bufferNativeResponse(endless, new AbortController().signal, 2),
    /chunk budget/,
  );
  assert.equal(cancelled, 1);
});

test("native response buffering cancels aborted streams without waiting for cancellation", async () => {
  const early = new AbortController();
  early.abort(new Error("early abort"));
  await assert.rejects(
    bufferNativeResponse(new Response(null, { status: 204 }), early.signal, 4),
    /early abort/,
  );
  const late = new AbortController();
  let cancelled = 0;
  const body = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        late.abort(new Error("late abort"));
      },
      cancel() {
        cancelled++;
        throw new Error("cancel failed");
      },
    }),
  );
  await assert.rejects(
    bufferNativeResponse(body, late.signal, 4),
    /late abort/,
  );
  assert.equal(cancelled, 1);
});

test("an errored response stream retains its read failure during cleanup", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body failed"));
      },
    }),
  );
  await assert.rejects(
    bufferNativeResponse(response, new AbortController().signal, 4),
    /body failed/,
  );
});

test("native response limits are finite and validated before locking the body", async () => {
  for (const limit of [NaN, Infinity, 0, -1, 8388609]) {
    const response = new Response("body");
    await assert.rejects(
      bufferNativeResponse(response, new AbortController().signal, limit),
      /Invalid native response byte budget/,
    );
    assert.equal(response.body?.locked, false);
  }
});

test("tiny and empty response producers yield to their cancellation deadline", async () => {
  for (const tiny of [false, true]) {
    const controller = new AbortController();
    let chunks = 0,
      cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(stream) {
          chunks++;
          stream.enqueue(tiny ? new Uint8Array([1]) : new Uint8Array());
        },
        cancel() {
          cancelled++;
        },
      }),
    );
    const timer = setTimeout(
      () => controller.abort(new Error("response deadline")),
      0,
    );
    try {
      await assert.rejects(
        bufferNativeResponse(response, controller.signal, 8388608),
        /response deadline/,
      );
      assert.ok(chunks < 65536);
      assert.equal(cancelled, 1);
    } finally {
      clearTimeout(timer);
    }
  }
});
