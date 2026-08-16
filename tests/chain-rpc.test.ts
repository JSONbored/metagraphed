// The validated JSON-RPC client every chain read goes through (#11194).
//
// WHY THIS FILE EXISTS. `chainRpc` is the single place the repo parses a
// JSON-RPC envelope instead of casting it, and until now NO test imported it --
// so the safeParse contract that four call sites depend on was unproven. That
// matters most for the case a cast cannot see: a proxy or captive portal
// answering 200 with HTML. A cast reads `undefined` off a string and the caller
// publishes an empty result; a parse says the transport lied.
//
// Every assertion here is about a DECLINE being distinguishable from an answer,
// which is the rule the whole boundary-parsing effort is built on.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  UNDESCRIBED_RPC_ERROR,
  chainRpc,
  chainRpcBatch,
  describeRpcError,
} from "../src/chain-rpc.ts";

const URL = "https://rpc.test/";

/** A fetch double returning one canned response. */
function respondWith(
  body: string,
  init: { status?: number; json?: boolean } = {},
): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: {
        "content-type": init.json === false ? "text/html" : "application/json",
      },
    })) as unknown as typeof fetch;
}

describe("chainRpc returns the result", () => {
  test("unwraps `result` from a well-formed envelope", async () => {
    const out = await chainRpc(URL, "state_getStorage", ["0x00"], {
      fetchImpl: respondWith(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xdead" }),
      ),
    });
    assert.equal(out, "0xdead");
  });

  test("an envelope with NO result key resolves to undefined, not a throw", async () => {
    // The schema makes `result` optional, and an absent System::Account entry
    // is a successful read of a zero balance -- not an RPC failure. Throwing
    // here would turn every never-seen account into a null balance.
    const out = await chainRpc(URL, "state_getStorage", ["0x00"], {
      fetchImpl: respondWith(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
    });
    assert.equal(out, undefined);
  });

  test("a null result is preserved rather than collapsed", async () => {
    const out = await chainRpc(URL, "state_getStorage", ["0x00"], {
      fetchImpl: respondWith(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
      ),
    });
    assert.equal(out, null);
  });
});

describe("chainRpc declines, and says which read failed", () => {
  test("throws on a non-2xx, naming the method", async () => {
    // These run inside lanes that call several in sequence, so "HTTP 500"
    // alone does not say which read failed.
    await assert.rejects(
      () =>
        chainRpc(URL, "state_getStorage", [], {
          fetchImpl: respondWith("nope", { status: 500 }),
        }),
      /state_getStorage: HTTP 500/,
    );
  });

  test("throws when the body is not JSON at all -- the captive-portal case", async () => {
    // THE CASE A CAST CANNOT SEE. `as JsonRpcResponseLike` over an HTML page
    // yields a value-shaped object whose fields are undefined, and the caller
    // publishes an empty answer indistinguishable from a real one.
    await assert.rejects(
      () =>
        chainRpc(URL, "state_getStorage", [], {
          fetchImpl: respondWith("<html>captive portal</html>", {
            json: false,
          }),
        }),
      /state_getStorage: response body was not JSON/,
    );
  });

  test("throws when the body is JSON but not an envelope", async () => {
    await assert.rejects(
      () =>
        chainRpc(URL, "state_getStorage", [], {
          fetchImpl: respondWith(JSON.stringify("just a string")),
        }),
      /state_getStorage: response was not a JSON-RPC envelope/,
    );
  });

  test("throws on an envelope carrying `error`, carrying the node's message", async () => {
    // Moved here from the accountInfoTotalRao suite: the decoder no longer sees
    // envelopes, so this is where an error envelope is pinned.
    await assert.rejects(
      () =>
        chainRpc(URL, "state_getStorage", [], {
          fetchImpl: respondWith(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32601, message: "Method not found" },
            }),
          ),
        }),
      /state_getStorage: .*Method not found/,
    );
  });

  test("an error envelope wins over a result on the same body", async () => {
    // A node that sends both is malformed; treating the result as usable would
    // publish a value the node itself disowned.
    await assert.rejects(
      () =>
        chainRpc(URL, "state_getStorage", [], {
          fetchImpl: respondWith(
            JSON.stringify({ result: "0xdead", error: { code: -1 } }),
          ),
        }),
      /state_getStorage/,
    );
  });
});

describe("describeRpcError", () => {
  test("prefers the node's message", () => {
    assert.match(
      describeRpcError({ code: -32601, message: "Method not found" }),
      /Method not found/,
    );
  });

  test("never returns an empty string for a shapeless error", () => {
    for (const shape of [null, undefined, {}, "boom", 42]) {
      assert.ok(
        describeRpcError(shape).length > 0,
        `empty description for ${JSON.stringify(shape)}`,
      );
    }
  });

  test("the floor holds even when BOTH serializations are empty", () => {
    // The only input that reaches the fallback: JSON.stringify declines it
    // (a function), and its own toString hands back nothing. Falling back to
    // `String(error)` here -- which this first did -- would have returned the
    // empty string it was called to replace, so the caller would read
    // `state_getStorage: ` with nothing after the colon.
    const mute = () => {};
    mute.toString = () => "";
    assert.equal(
      JSON.stringify(mute),
      undefined,
      "premise: stringify declines",
    );
    assert.equal(String(mute), "", "premise: toString is empty");
    assert.equal(describeRpcError(mute), UNDESCRIBED_RPC_ERROR);
  });
});

/**
 * The BATCH client, which is what turned raw capture's cost from three HTTP
 * requests per block into two per chunk.
 *
 * The endpoint meters HTTP REQUESTS, not JSON-RPC calls -- measured 2026-08-16
 * against archive.chain.opentensor.ai: one call per request 429'd after 103,
 * while fifty calls per request carried 1,400 through 140 requests untouched.
 * So the batch is worth having, and the two things that make it SAFE are
 * tested here: correlation by id, and a request-level failure staying
 * distinguishable from a call-level one.
 */
describe("chainRpcBatch", () => {
  /** A node that answers each call by echoing its method and first param. */
  const echo = (opts: { shuffle?: boolean; drop?: number } = {}) =>
    (async (_url: unknown, init?: { body?: string }) => {
      const calls = JSON.parse(init?.body ?? "[]") as {
        id: number;
        method: string;
        params: unknown[];
      }[];
      const replies = calls
        .filter((call) => call.id !== opts.drop)
        .map((call) => ({
          id: call.id,
          result: `${call.method}:${String(call.params[0])}`,
        }));
      return {
        ok: true,
        json: async () => (opts.shuffle ? replies.reverse() : replies),
      } as unknown as Response;
    }) as unknown as typeof fetch;

  test("returns results aligned to the calls, in one request", async () => {
    let requests = 0;
    const counting = (async (url: unknown, init?: { body?: string }) => {
      requests += 1;
      return echo()(url as never, init as never);
    }) as unknown as typeof fetch;
    const out = await chainRpcBatch(
      URL,
      [
        { method: "chain_getBlock", params: ["0xa"] },
        { method: "state_getStorage", params: ["0xb"] },
      ],
      { fetchImpl: counting },
    );
    assert.equal(requests, 1, "both calls rode one round trip");
    assert.deepEqual(out, [
      { ok: true, result: "chain_getBlock:0xa" },
      { ok: true, result: "state_getStorage:0xb" },
    ]);
  });

  test("aligns by id even when the node reorders the batch", async () => {
    // JSON-RPC explicitly permits any order. Reading positionally is a bug
    // that hides until a node reorders, and then silently pairs every answer
    // with the wrong question.
    const out = await chainRpcBatch(
      URL,
      [
        { method: "a", params: [1] },
        { method: "b", params: [2] },
        { method: "c", params: [3] },
      ],
      { fetchImpl: echo({ shuffle: true }) },
    );
    assert.deepEqual(out, [
      { ok: true, result: "a:1" },
      { ok: true, result: "b:2" },
      { ok: true, result: "c:3" },
    ]);
  });

  test("sends no request at all for no calls", async () => {
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    assert.deepEqual(await chainRpcBatch(URL, [], { fetchImpl: never }), []);
  });

  test("a call-level error is DATA, so the caller keeps the rest", async () => {
    const oneBad = (async (_u: unknown, init?: { body?: string }) => {
      const calls = JSON.parse(init?.body ?? "[]") as { id: number }[];
      return {
        ok: true,
        json: async () =>
          calls.map((call) =>
            call.id === 1
              ? { id: call.id, error: { message: "state already discarded" } }
              : { id: call.id, result: "ok" },
          ),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const out = await chainRpcBatch(
      URL,
      [
        { method: "a", params: [] },
        { method: "b", params: [] },
        { method: "c", params: [] },
      ],
      { fetchImpl: oneBad },
    );
    assert.deepEqual(out[0], { ok: true, result: "ok" });
    assert.equal(out[1]!.ok, false);
    assert.match(
      (out[1] as { error: string }).error,
      /b: state already discarded/,
      "prefixed with the method, because a chunk calls several in one request",
    );
    assert.deepEqual(out[2], { ok: true, result: "ok" });
  });

  test("an unanswered call is reported per-call, not as a whole failure", async () => {
    const out = await chainRpcBatch(
      URL,
      [
        { method: "a", params: [] },
        { method: "b", params: [] },
      ],
      { fetchImpl: echo({ drop: 1 }) },
    );
    assert.equal(out[0]!.ok, true);
    assert.equal(out[1]!.ok, false);
    assert.match((out[1] as { error: string }).error, /no response for id 1/);
  });

  test("a non-2xx throws: nothing was read, so there is no prefix to keep", async () => {
    const dead = (async () =>
      ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch;
    await assert.rejects(
      chainRpcBatch(URL, [{ method: "a", params: [] }], { fetchImpl: dead }),
      /batch\(1\): HTTP 429/,
    );
  });

  test("an unparseable body throws", async () => {
    const html = (async () =>
      ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      chainRpcBatch(URL, [{ method: "a", params: [] }], { fetchImpl: html }),
      /was not JSON/,
    );
  });

  test("a single error OBJECT answering a batch throws, never reads as empty", async () => {
    // The live shape over the node's stated 50-call limit: HTTP 200 carrying
    // one error object. Read as an empty array it would look like a clean
    // batch of no results and advance a watermark across nothing.
    const tooLarge = (async () =>
      ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          error: {
            code: -32010,
            message: "The batch request was too large",
            data: "Exceeded max limit of 50",
          },
          id: null,
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      chainRpcBatch(URL, [{ method: "a", params: [] }], {
        fetchImpl: tooLarge,
      }),
      /was not a JSON-RPC batch/,
    );
  });

  test("a duplicate id throws rather than picking one arbitrarily", async () => {
    // Ambiguous correlation. Keeping either answer hands some call a result
    // that is not its own, which is wrong data rather than missing data.
    const dupes = (async () =>
      ({
        ok: true,
        json: async () => [
          { id: 0, result: "first" },
          { id: 0, result: "second" },
        ],
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      chainRpcBatch(
        URL,
        [
          { method: "a", params: [] },
          { method: "b", params: [] },
        ],
        { fetchImpl: dupes },
      ),
      /duplicate id 0/,
    );
  });

  test("falls back to the global fetch when none is injected", async () => {
    // The shipped path. Every other test injects a fetch, so without this the
    // default the Worker actually runs on is exercised by nothing.
    const original = globalThis.fetch;
    let calledGlobal = false;
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      calledGlobal = true;
      const calls = JSON.parse(init?.body ?? "[]") as { id: number }[];
      return {
        ok: true,
        json: async () => calls.map((call) => ({ id: call.id, result: "ok" })),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const out = await chainRpcBatch(URL, [{ method: "a", params: [] }]);
      assert.deepEqual(out, [{ ok: true, result: "ok" }]);
      assert.ok(calledGlobal, "the global fetch must be the default");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("carries a timeout when one is asked for", async () => {
    let sawSignal = false;
    const watching = (async (_u: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return echo()(_u as never, init as never);
    }) as unknown as typeof fetch;
    await chainRpcBatch(URL, [{ method: "a", params: [] }], {
      fetchImpl: watching,
      timeoutMs: 5_000,
    });
    assert.ok(sawSignal, "timeoutMs must reach the request");
  });
});
