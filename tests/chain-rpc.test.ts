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
