import assert from "node:assert/strict";
import { test } from "vitest";
import { readBoundedRequestText } from "../workers/http.ts";

test("oversized request refusal does not wait for stream cancellation", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  assert.deepEqual(
    await readBoundedRequestText({ headers: new Headers(), body }, 4),
    {
      ok: false,
      text: "",
    },
  );
  assert.equal(cancelled, true);
});

test("oversized request refusal tolerates a rejected cancellation", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      return Promise.reject(new Error("cancellation failed"));
    },
  });
  assert.deepEqual(
    await readBoundedRequestText({ headers: new Headers(), body }, 4),
    {
      ok: false,
      text: "",
    },
  );
});
