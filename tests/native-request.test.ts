import assert from "node:assert/strict";
import { test } from "vitest";
import { bufferNativeRequest } from "../src/native-request.ts";

function request(body: ReadableStream<Uint8Array>) {
  return new Request("https://fixture.invalid/action", {
    method: "POST",
    headers: { "x-fixture": "kept" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

test("native requests retain exact bytes, headers and existing large byte limits", async () => {
  const input = request(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
        controller.enqueue(new Uint8Array([128]));
        controller.close();
      },
    }),
  );
  const result = await bufferNativeRequest(
    input,
    new AbortController().signal,
    32 * 1024 * 1024,
  );
  assert.equal(result.url, input.url);
  assert.equal(result.method, "POST");
  assert.equal(result.headers.get("x-fixture"), "kept");
  assert.deepEqual(
    new Uint8Array(await result.arrayBuffer()),
    new Uint8Array([0, 255, 128]),
  );
  assert.equal(
    (
      await bufferNativeRequest(
        new Request("https://fixture.invalid/"),
        new AbortController().signal,
        1,
      )
    ).body,
    null,
  );
});

test("native request budgets are finite and enforced before acquiring state", async () => {
  for (const max of [NaN, Infinity, 0, -1, 1.5]) {
    const input = new Request("https://fixture.invalid/action", {
      method: "POST",
      body: "x",
    });
    await assert.rejects(
      bufferNativeRequest(input, new AbortController().signal, max),
      /Invalid native request byte budget/,
    );
    assert.equal(input.body?.locked, false);
  }
  await assert.rejects(
    bufferNativeRequest(
      new Request("https://fixture.invalid/action", {
        method: "POST",
        body: "abc",
      }),
      new AbortController().signal,
      2,
    ),
    /byte limit/,
  );
  let cancelled = 0;
  const endless = request(
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
    bufferNativeRequest(endless, new AbortController().signal, 2),
    /chunk limit/,
  );
  assert.equal(cancelled, 1);
});

test("tiny and empty request producers yield to their cancellation deadline", async () => {
  for (const tiny of [false, true]) {
    const controller = new AbortController();
    let chunks = 0,
      cancelled = 0;
    const input = request(
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
      () => controller.abort(new Error("request deadline")),
      0,
    );
    try {
      await assert.rejects(
        bufferNativeRequest(input, controller.signal, 32 * 1024 * 1024),
        /request deadline/,
      );
      assert.ok(chunks < 65536);
      assert.equal(cancelled, 1);
    } finally {
      clearTimeout(timer);
    }
  }
});

test("request cancellation and stream errors retain their original failure", async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("already aborted"));
  await assert.rejects(
    bufferNativeRequest(
      new Request("https://fixture.invalid/"),
      aborted.signal,
      1,
    ),
    /already aborted/,
  );
  const broken = request(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("request stream failed"));
      },
    }),
  );
  await assert.rejects(
    bufferNativeRequest(broken, new AbortController().signal, 10),
    /request stream failed/,
  );
});
