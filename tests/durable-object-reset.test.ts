// #11021. Cloudflare evicts a Durable Object when its script version changes,
// and this repo deploys ~10x a day (29 distinct script_version ids in one
// 3-day window). Once reset, EVERY pending operation on that instance rejects
// -- and on the public SSE route that reached a subscriber as an HTTP 500.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import {
  CHAIN_FIREHOSE_RECONNECT_MS,
  isDurableObjectReset,
} from "../src/durable-object-reset.ts";

const RESET = "Durable Object reset because its code was updated.";

describe("the reset predicate is narrow on purpose (#11021)", () => {
  test("matches the runtime's exact message", () => {
    assert.equal(isDurableObjectReset(new Error(RESET)), true);
  });

  // The risk of this helper is OVER-matching: a broad predicate would swallow
  // real DO failures, and a hub that has genuinely stopped looks identical to
  // one that was just redeployed. Each of these is a failure we must still see.
  test("does not match anything else", () => {
    for (const other of [
      new Error("Durable Object reset"),
      new Error("durable object reset because its code was updated."),
      new Error("Network connection lost."),
      new Error("Worker exceeded memory limit."),
      new Error(""),
      RESET,
      null,
      undefined,
      { message: RESET },
    ]) {
      assert.equal(isDurableObjectReset(other), false, String(other));
    }
  });
});

/** An env whose firehose stub rejects the way an evicted DO does. */
function envWithHub(rejection: unknown) {
  return {
    CHAIN_FIREHOSE_HUB: {
      idFromName: () => "global",
      get: () => ({
        fetch: async () => {
          throw rejection;
        },
      }),
    },
  } as unknown as Parameters<typeof handleRequest>[1];
}

const streamReq = (headers: Record<string, string> = {}) =>
  new Request("https://api.metagraph.sh/api/v1/chain/stream?topics=blocks", {
    headers,
  });

describe("a deploy does not 500 a subscriber (#11021)", () => {
  test("SSE gets a 200 event-stream that closes, carrying retry:", async () => {
    // NOT a 5xx, and that is the whole point: the EventSource spec makes a
    // client FAIL THE CONNECTION permanently on a non-2xx status, so a 503
    // here would be worse than the 500 it replaces -- every browser subscriber
    // would give up for good rather than come back after the deploy.
    const res = await handleRequest(
      streamReq(),
      envWithHub(new Error(RESET)),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await res.text();
    assert.match(body, new RegExp(`retry: ${CHAIN_FIREHOSE_RECONNECT_MS}`));
    // Never replayed as if it were the stream.
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("a WebSocket upgrade gets 503 + Retry-After instead", async () => {
    // No stream to close and no retry: field; WS clients run their own backoff.
    const res = await handleRequest(
      streamReq({ upgrade: "websocket" }),
      envWithHub(new Error(RESET)),
      {},
    );
    assert.equal(res.status, 503);
    assert.equal(
      res.headers.get("retry-after"),
      String(Math.ceil(CHAIN_FIREHOSE_RECONNECT_MS / 1000)),
    );
  });

  test("any OTHER hub failure still surfaces -- this is not a blanket catch", async () => {
    // The failure mode that matters more than the fix: swallowing everything
    // here would make a genuinely dead hub indistinguishable from a deploy.
    // It ESCAPES -- the rejection is rethrown, not converted into a reconnect.
    // That is the assertion: a real hub failure must keep reaching the error
    // channel exactly as it did before.
    await assert.rejects(
      () =>
        handleRequest(streamReq(), envWithHub(new Error("hub exploded")), {}),
      /hub exploded/,
    );
  });
});
