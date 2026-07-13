// Unit tests for workers/mcp-session-hub.mjs (#4983 MCP half, ADR 0015).
//
// Unlike chain-firehose-hub.mjs, almost the ENTIRE class here is plain-Node-
// testable: state.storage is a simple async get/put/setAlarm KV API (easy to
// stub with a real Map), and ReadableStream/TextEncoder are real Web Streams
// APIs under Node/vitest -- nothing in this file needs WebSocketPair, so
// there is no v8-ignored branch to account for.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  MCP_CHAIN_STREAM_RESOURCE_URI,
  MCP_SESSION_ID_MAX_LENGTH,
  MCP_SESSION_IDLE_TTL_MS,
  MCP_SESSION_MAX_STREAM_DURATION_MS,
  McpSessionHub,
  buildResourceUpdatedNotification,
  formatMcpSseEvent,
  isValidMcpSessionId,
} from "../workers/mcp-session-hub.mjs";

// --- isValidMcpSessionId ---------------------------------------------------------

test("isValidMcpSessionId: accepts a real crypto.randomUUID()-shaped id", () => {
  assert.equal(
    isValidMcpSessionId("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    true,
  );
});

test("isValidMcpSessionId: rejects non-strings", () => {
  assert.equal(isValidMcpSessionId(undefined), false);
  assert.equal(isValidMcpSessionId(null), false);
  assert.equal(isValidMcpSessionId(42), false);
});

test("isValidMcpSessionId: rejects an empty string", () => {
  assert.equal(isValidMcpSessionId(""), false);
});

test("isValidMcpSessionId: rejects a string longer than MCP_SESSION_ID_MAX_LENGTH", () => {
  assert.equal(
    isValidMcpSessionId("a".repeat(MCP_SESSION_ID_MAX_LENGTH)),
    true,
  );
  assert.equal(
    isValidMcpSessionId("a".repeat(MCP_SESSION_ID_MAX_LENGTH + 1)),
    false,
  );
});

test("isValidMcpSessionId: rejects characters outside visible ASCII 0x21-0x7E", () => {
  assert.equal(isValidMcpSessionId("has space"), false);
  assert.equal(isValidMcpSessionId("has\ttab"), false);
  assert.equal(isValidMcpSessionId("has\nnewline"), false);
  assert.equal(isValidMcpSessionId("emoji😀"), false);
});

// --- buildResourceUpdatedNotification / formatMcpSseEvent -----------------------

test("buildResourceUpdatedNotification: matches the MCP spec's exact shape (uri only, no other params)", () => {
  assert.deepEqual(
    buildResourceUpdatedNotification(MCP_CHAIN_STREAM_RESOURCE_URI),
    {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
    },
  );
});

test("formatMcpSseEvent: frames a notification with an id: line and a data: line", () => {
  const notification = buildResourceUpdatedNotification(
    "metagraph://chain/stream",
  );
  assert.equal(
    formatMcpSseEvent(1, notification),
    `id: 1\ndata: ${JSON.stringify(notification)}\n\n`,
  );
});

// --- test helpers ----------------------------------------------------------------

function createStubStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  let alarmTime = null;
  return {
    async get(keys) {
      const result = new Map();
      for (const key of keys) {
        if (data.has(key)) result.set(key, data.get(key));
      }
      return result;
    },
    async put(entries) {
      for (const [key, value] of Object.entries(entries)) {
        data.set(key, value);
      }
    },
    async setAlarm(time) {
      alarmTime = time;
    },
    get lastAlarmTime() {
      return alarmTime;
    },
    get raw() {
      return data;
    },
  };
}

function stubState(initial) {
  return { storage: createStubStorage(initial) };
}

function fakeChainFirehoseHubBinding() {
  const calls = [];
  return {
    calls,
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- handleSubscribe / handleUnsubscribe -----------------------------------------

test("handleSubscribe: a valid uri subscribes, persists, and notifies ChainFirehoseHub", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.subscribedUris.has(MCP_CHAIN_STREAM_RESOURCE_URI), true);
  assert.equal(hub.sessionId, "session-1");
  assert.equal(firehose.calls.length, 1);
  assert.match(firehose.calls[0].url, /\/mcp-subscribe$/);
  assert.deepEqual(firehose.calls[0].body, { sessionId: "session-1" });
});

test("handleSubscribe: rejects a non-subscribable uri with 400, without touching state or notifying", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: "metagraph://registry/summary",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(hub.subscribedUris.size, 0);
  assert.equal(firehose.calls.length, 0);
});

test("handleSubscribe: works even when CHAIN_FIREHOSE_HUB isn't bound (local/CI)", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.subscribedUris.has(MCP_CHAIN_STREAM_RESOURCE_URI), true);
});

test("handleUnsubscribe: removes the uri and notifies ChainFirehoseHub once the set becomes empty", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  firehose.calls.length = 0; // discard the subscribe notification
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/unsubscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.subscribedUris.size, 0);
  assert.equal(firehose.calls.length, 1);
  assert.match(firehose.calls[0].url, /\/mcp-unsubscribe$/);
});

test("handleUnsubscribe: works even when CHAIN_FIREHOSE_HUB isn't bound (local/CI)", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/unsubscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.subscribedUris.size, 0);
});

test("handleUnsubscribe: unsubscribing something never subscribed to is a harmless no-op (no notify, since the set was already empty)", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/unsubscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
  // subscribedUris was already empty -> "becomes empty" fires the notify
  // exactly once (size === 0 both before and after is still `=== 0`).
  assert.equal(firehose.calls.length, 1);
});

// --- handleNotify / deliverNow ----------------------------------------------------

test("handleNotify: a notification for a URI this session never subscribed to is a no-op (delivered:false)", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/notify", {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.deepEqual(await res.json(), { ok: true, delivered: false });
});

test("handleNotify: with no open stream, coalesces into pendingUris rather than delivering immediately", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/notify", {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.deepEqual(await res.json(), { ok: true, delivered: true });
  assert.equal(hub.pendingUris.has(MCP_CHAIN_STREAM_RESOURCE_URI), true);
});

test("handleNotify: a burst of notifications before any stream opens coalesces to ONE pending marker, not a growing queue", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  for (let i = 0; i < 5; i += 1) {
    await hub.fetch(
      jsonRequest("https://mcp-session-hub.internal/notify", {
        uri: MCP_CHAIN_STREAM_RESOURCE_URI,
      }),
    );
  }
  assert.equal(hub.pendingUris.size, 1);
});

test("deliverNow: enqueues a framed SSE event, increments sequence, and clears the pending flag on success", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const enqueued = [];
  hub.streamController = { enqueue: (chunk) => enqueued.push(chunk) };
  hub.pendingUris.add(MCP_CHAIN_STREAM_RESOURCE_URI);
  hub.deliverNow(MCP_CHAIN_STREAM_RESOURCE_URI);
  assert.equal(hub.sequence, 1);
  assert.equal(hub.pendingUris.has(MCP_CHAIN_STREAM_RESOURCE_URI), false);
  const text = new TextDecoder().decode(enqueued[0]);
  assert.match(text, /^id: 1\ndata: /);
  assert.match(text, /notifications\/resources\/updated/);
});

test("deliverNow: an enqueue failure (stream already closed/errored) nulls streamController and leaves the uri pending for the next open", () => {
  const hub = new McpSessionHub(stubState(), {});
  hub.streamController = {
    enqueue: () => {
      throw new Error("stream closed");
    },
  };
  hub.pendingUris.add(MCP_CHAIN_STREAM_RESOURCE_URI);
  hub.deliverNow(MCP_CHAIN_STREAM_RESOURCE_URI);
  assert.equal(hub.streamController, null);
  assert.equal(hub.pendingUris.has(MCP_CHAIN_STREAM_RESOURCE_URI), true);
});

// --- handleStream ------------------------------------------------------------------

test("handleStream: opens an SSE stream, flushing any pending notification immediately", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/notify", {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(hub.pendingUris.size, 1);
  const res = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /notifications\/resources\/updated/);
  assert.equal(hub.pendingUris.size, 0);
  await reader.cancel();
});

test("handleStream: opens fine with no sessionId query param (already known from an earlier /subscribe call)", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  const res = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream"),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.sessionId, "session-1"); // unchanged, not overwritten with null
  await res.body.cancel();
});

test("handleStream: a second concurrent stream request for the same session is rejected with 409", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const first = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  assert.equal(first.status, 200);
  const second = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  assert.equal(second.status, 409);
  await first.body.cancel();
});

test("handleNotify: with a stream already open, delivers immediately (deliverNow) instead of coalescing into pendingUris", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  const streamRes = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  const reader = streamRes.body.getReader();
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/notify", {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(hub.pendingUris.size, 0);
  assert.equal(hub.sequence, 1);
  const { value } = await reader.read();
  assert.match(
    new TextDecoder().decode(value),
    /notifications\/resources\/updated/,
  );
  await reader.cancel();
});

test("handleStream: cancelling the stream clears streamController, allowing a new stream to open", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const first = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  await first.body.cancel();
  assert.equal(hub.streamController, null);
  const second = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  assert.equal(second.status, 200);
  await second.body.cancel();
});

test("handleStream: auto-closes after MCP_SESSION_MAX_STREAM_DURATION_MS, per the spec's 'servers may disconnect SSE streams at will' allowance", async () => {
  vi.useFakeTimers();
  try {
    const hub = new McpSessionHub(stubState(), {});
    const res = await hub.fetch(
      new Request(
        "https://mcp-session-hub.internal/stream?sessionId=session-1",
      ),
    );
    const reader = res.body.getReader();
    assert.notEqual(hub.streamController, null);
    vi.advanceTimersByTime(MCP_SESSION_MAX_STREAM_DURATION_MS);
    // Let the microtask queue (the setTimeout callback + controller.close())
    // flush before asserting -- fake timers fire synchronously but the
    // ReadableStream's close() resolution is still a microtask.
    await vi.runAllTimersAsync();
    assert.equal(hub.streamController, null);
    assert.equal(hub.streamCloseTimer, null);
    const { done } = await reader.read();
    assert.equal(done, true);
  } finally {
    vi.useRealTimers();
  }
});

// --- handleTerminate / alarm --------------------------------------------------------

test("handleTerminate: unsubscribes from ChainFirehoseHub (using the request body's sessionId), closes any open stream, and clears state", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  const streamRes = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  firehose.calls.length = 0;
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.terminated, true);
  assert.equal(hub.subscribedUris.size, 0);
  assert.equal(hub.streamController, null);
  assert.equal(firehose.calls.length, 1);
  assert.match(firehose.calls[0].url, /\/mcp-unsubscribe$/);
  await streamRes.body.cancel().catch(() => {}); // already closed by terminate
});

test("handleTerminate: calling it twice is idempotent (second call doesn't re-notify)", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  firehose.calls.length = 0;
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(firehose.calls.length, 1);
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(firehose.calls.length, 1); // unchanged -- no second notify
});

test("handleTerminate: calling the method directly a second time (bypassing fetch()'s own terminated-gate, as alarm() does) is still a no-op", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  await hub.handleTerminate(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(hub.terminated, true);
  const res = await hub.handleTerminate(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(firehose.calls.length, 0); // no subscriptions -> never called
});

test("handleTerminate: with no subscriptions, never calls ChainFirehoseHub at all", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const hub = new McpSessionHub(stubState(), { CHAIN_FIREHOSE_HUB: firehose });
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  assert.equal(firehose.calls.length, 0);
});

test("fetch: any route other than /notify 404s once the session is terminated", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  const subscribeRes = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(subscribeRes.status, 404);
  const streamRes = await hub.fetch(
    new Request("https://mcp-session-hub.internal/stream?sessionId=session-1"),
  );
  assert.equal(streamRes.status, 404);
});

test("fetch: /notify still resolves (as a no-op) even for a terminated session -- a race with ChainFirehoseHub forgetting it, not an error", async () => {
  const hub = new McpSessionHub(stubState(), {});
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/terminate", {
      sessionId: "session-1",
    }),
  );
  const res = await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/notify", {
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  assert.equal(res.status, 200);
});

test("fetch: an unrecognized path 404s", async () => {
  const hub = new McpSessionHub(stubState(), {});
  const res = await hub.fetch(
    new Request("https://mcp-session-hub.internal/nope"),
  );
  assert.equal(res.status, 404);
});

test("alarm: self-terminates using the persisted sessionId (no caller to hand it one)", async () => {
  const firehose = fakeChainFirehoseHubBinding();
  const state = stubState();
  const hub = new McpSessionHub(state, { CHAIN_FIREHOSE_HUB: firehose });
  await hub.fetch(
    jsonRequest("https://mcp-session-hub.internal/subscribe", {
      sessionId: "session-1",
      uri: MCP_CHAIN_STREAM_RESOURCE_URI,
    }),
  );
  firehose.calls.length = 0;

  // Simulate a fresh DO instance waking to run the alarm -- hydrate() has to
  // recover sessionId from storage, not from a live `this.sessionId`.
  const revivedHub = new McpSessionHub(state, { CHAIN_FIREHOSE_HUB: firehose });
  await revivedHub.alarm();
  assert.equal(revivedHub.terminated, true);
  assert.equal(firehose.calls.length, 1);
  assert.deepEqual(firehose.calls[0].body, { sessionId: "session-1" });
});

test("touch: sets a Durable Object alarm MCP_SESSION_IDLE_TTL_MS in the future", async () => {
  const state = stubState();
  const hub = new McpSessionHub(state, {});
  const before = Date.now();
  await hub.touch();
  const alarmTime = state.storage.lastAlarmTime;
  assert.ok(alarmTime >= before + MCP_SESSION_IDLE_TTL_MS);
  assert.ok(alarmTime <= Date.now() + MCP_SESSION_IDLE_TTL_MS + 1000);
});

test("MCP_SESSION_MAX_STREAM_DURATION_MS and MCP_SESSION_IDLE_TTL_MS are the documented magnitudes (minutes, not ms/hours by mistake)", () => {
  assert.equal(MCP_SESSION_MAX_STREAM_DURATION_MS, 5 * 60 * 1000);
  assert.equal(MCP_SESSION_IDLE_TTL_MS, 30 * 60 * 1000);
});
