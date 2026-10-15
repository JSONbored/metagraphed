import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { readBoundedRequestText } from "../workers/http.ts";

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request("https://fixture.invalid", {
    method: "POST",
    body,
    signal,
    duplex: "half",
  } as RequestInit);
}

test("bounded text preserves split UTF-8 and releases the reader on completion", async () => {
  const encoded = new TextEncoder().encode("é🧬");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 1));
      controller.enqueue(encoded.subarray(1));
      controller.close();
    },
  });
  assert.deepEqual(
    await readBoundedRequestText(request(stream), encoded.length),
    {
      ok: true,
      text: "é🧬",
    },
  );
  assert.equal(stream.locked, false);
});

for (const outcome of ["pending", "rejected", "resolved"] as const)
  test(`overflow returns without waiting for ${outcome} cancellation`, async () => {
    const cancel = vi.fn(() => {
      if (outcome === "pending") return new Promise<void>(() => undefined);
      if (outcome === "rejected")
        return Promise.reject(new Error("cleanup failed"));
      return Promise.resolve();
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      cancel,
    });
    assert.deepEqual(await readBoundedRequestText(request(stream), 1), {
      ok: false,
      text: "",
    });
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(stream.locked, false);
  });

test("reader failures preserve the original failure and release the lock", async () => {
  const reason = new Error("read failed");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(reason);
    },
  });
  await assert.rejects(
    readBoundedRequestText(request(stream), 10),
    (error) => error === reason,
  );
  assert.equal(stream.locked, false);
});
