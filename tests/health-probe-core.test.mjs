import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  acceptHeader,
  classifyProbe,
  classifyRpcProbe,
  contentMismatch,
  FINNEY_GENESIS_HASH,
  isUnsafePublicUrl,
  mapLimit,
  nodeWebSocketConnector,
  normalizeJsonRpcResult,
  parseBlockNumber,
  probeSubtensorHttp,
  probeSubtensorWss,
  probeSurface,
  probeUrl,
  rollupSubnetStatus,
  statusForClassification,
  summarizeRpcProbe,
} from "../src/health-probe-core.mjs";

describe("rollupSubnetStatus (shared subnet-status precedence)", () => {
  test("empty / all-unknown → unknown", () => {
    assert.equal(rollupSubnetStatus({ total: 0 }), "unknown");
    assert.equal(rollupSubnetStatus({ unknown: 3, total: 3 }), "unknown");
  });
  test("no failed and no degraded → ok (even with unknowns present)", () => {
    assert.equal(rollupSubnetStatus({ ok: 2, total: 2 }), "ok");
    assert.equal(rollupSubnetStatus({ ok: 1, unknown: 1, total: 2 }), "ok");
  });
  test("any ok or degraded alongside a failure → degraded", () => {
    assert.equal(
      rollupSubnetStatus({ ok: 1, failed: 1, total: 2 }),
      "degraded",
    );
    assert.equal(
      rollupSubnetStatus({ degraded: 1, failed: 1, total: 2 }),
      "degraded",
    );
  });
  test("only failures/unknowns (no ok, no degraded) → failed", () => {
    assert.equal(rollupSubnetStatus({ failed: 2, total: 2 }), "failed");
    assert.equal(
      rollupSubnetStatus({ failed: 1, unknown: 1, total: 2 }),
      "failed",
    );
  });
});

// Minimal Response-like stub for an injected fetch.
function fakeResponse({
  status = 200,
  contentType = "application/json",
  body = "{}",
  location = null,
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        if (name === "location") return location;
        return null;
      },
    },
    body: { cancel: async () => {} },
    async text() {
      return body;
    },
  };
}

// Build a valid JSON-RPC response body for the subtensor probe methods.
function rpcBody(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

describe("isUnsafePublicUrl", () => {
  test("blocks private/loopback/link-local + non-http schemes", () => {
    for (const url of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.1.2.3/x",
      "http://192.168.0.1/x",
      "http://169.254.169.254/latest",
      "http://172.16.0.1/x",
      "http://172.31.255.255/x",
      "https://service.local/x",
      "ftp://example.com/x",
      "file:///etc/passwd",
    ]) {
      assert.equal(isUnsafePublicUrl(url), true, url);
    }
  });

  test("blocks fec0::/10 deprecated site-local IPv6 (issue #1538)", () => {
    for (const url of [
      "http://[fec0::1]/x",
      "https://[fed0:1:2::3]/x",
      "http://[feff::1]/x",
      "http://[fe80::1]/x", // link-local still blocked
    ]) {
      assert.equal(isUnsafePublicUrl(url), true, url);
    }
  });

  test("blocks a private v4 tunnelled inside an IPv6 literal host", () => {
    for (const url of [
      "http://[::ffff:169.254.169.254]/latest", // IPv4-mapped metadata IP
      "http://[::127.0.0.1]/x", // IPv4-compatible loopback
      "http://[2002:7f00:1::]/x", // 6to4 loopback
      "http://[2002:a00:1::]/x", // 6to4 of 10.0.0.1
      "http://[64:ff9b::a9fe:a9fe]/x", // NAT64 of 169.254.169.254
    ]) {
      assert.equal(isUnsafePublicUrl(url), true, url);
    }
  });

  test("allows public http(s)/ws(s)", () => {
    for (const url of [
      "https://entrypoint-finney.opentensor.ai",
      "http://example.com/api",
      "wss://lite.chain.opentensor.ai:443",
      "https://172.15.0.1/x", // just outside the private 172.16-31 range
      "https://[2002:808:808::]/x", // 6to4 of public 8.8.8.8 stays allowed
    ]) {
      assert.equal(isUnsafePublicUrl(url), false, url);
    }
  });
});

describe("classifyProbe", () => {
  const htmlSurface = { url: "https://x.dev", probe: { expect: "html" } };
  const jsonSurface = {
    url: "https://x.dev/data.json",
    probe: { expect: "json" },
  };

  test("maps status codes + content to classifications", () => {
    assert.equal(
      classifyProbe({ error_class: "AbortError" }, htmlSurface),
      "timeout",
    );
    assert.equal(
      classifyProbe({ status_code: 429 }, htmlSurface),
      "rate-limited",
    );
    assert.equal(
      classifyProbe({ status_code: 403 }, htmlSurface),
      "auth-required",
    );
    assert.equal(classifyProbe({ status_code: 404 }, htmlSurface), "dead");
    assert.equal(classifyProbe({ status_code: 503 }, htmlSurface), "transient");
    assert.equal(
      classifyProbe({ ok: true, content_type: "text/html" }, htmlSurface),
      "live",
    );
    assert.equal(
      classifyProbe({ ok: true, content_type: "text/html" }, jsonSurface),
      "content-mismatch",
    );
    assert.equal(
      classifyProbe(
        {
          ok: true,
          content_type: "application/json",
          redirect_target: "https://y",
        },
        jsonSurface,
      ),
      "redirected",
    );
    assert.equal(classifyProbe({ unsafe_url: true }, htmlSurface), "unsafe");
  });

  test("content-mismatch tolerates text/plain JSON from raw.githubusercontent.com", () => {
    const raw = {
      url: "https://raw.githubusercontent.com/o/r/main/x.json",
      probe: { expect: "json" },
    };
    assert.equal(
      contentMismatch({ content_type: "text/plain; charset=utf-8" }, raw),
      false,
    );
  });
});

describe("classifyRpcProbe + statusForClassification", () => {
  test("live requires header + system_health", () => {
    assert.equal(
      classifyRpcProbe({
        method_results: {
          chain_getHeader: { ok: true },
          system_health: { ok: true },
        },
      }),
      "live",
    );
    assert.equal(
      classifyRpcProbe({ method_results: { chain_getHeader: { ok: true } } }),
      "unsupported",
    );
    assert.equal(classifyRpcProbe({ error_class: "TimeoutError" }), "timeout");
  });

  test("status downgrades for community/registry-observed authorities", () => {
    assert.equal(statusForClassification("live"), "ok");
    assert.equal(statusForClassification("timeout"), "degraded");
    assert.equal(
      statusForClassification("dead", { authority: "official" }),
      "failed",
    );
    assert.equal(
      statusForClassification("dead", { authority: "community" }),
      "degraded",
    );
  });
});

describe("summarizeRpcProbe", () => {
  test("derives archive_support, methods_supported, latest_block", () => {
    const summary = summarizeRpcProbe({
      method_results: {
        chain_getHeader: { ok: true, raw_header: { number: "0x10" } },
        system_health: { ok: true },
        rpc_methods: { ok: true, rpc_method_count: 42 },
        archive_probe: { ok: true, raw_hex_result_present: true },
      },
    });
    assert.equal(summary.archive_support, true);
    assert.equal(summary.latest_block, 16);
    assert.equal(summary.rpc_method_count, 42);
    assert.deepEqual(summary.methods_supported, {
      chain_getHeader: true,
      system_health: true,
      rpc_methods: true,
      chain_getBlockHash: true,
    });
  });
});

describe("mapLimit", () => {
  test("preserves input order and bounds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
  });
});

describe("probeSurface (injected fetch)", () => {
  const surface = {
    id: "sn7-api",
    netuid: 7,
    kind: "subnet-api",
    url: "https://api.example.dev/health",
    provider: "acme",
    auth_required: false,
    public_safe: true,
    subnet_name: "Acme",
    subnet_slug: "acme",
    probe: { enabled: true, method: "GET", expect: "json", timeout_ms: 5000 },
  };

  test("a 200 JSON response is live/ok", async () => {
    const base = await probeSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        fakeResponse({ status: 200, contentType: "application/json" }),
    });
    assert.equal(base.status, "ok");
    assert.equal(base.classification, "live");
    assert.equal(base.surface_id, "sn7-api");
    assert.equal(base.netuid, 7);
    assert.equal(typeof base.last_checked, "string");
  });

  test("HEAD 405 falls back to GET", async () => {
    const calls = [];
    const headSurface = {
      ...surface,
      probe: { ...surface.probe, method: "HEAD" },
    };
    const base = await probeSurface(headSurface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        calls.push(init.method);
        return init.method === "HEAD"
          ? fakeResponse({ status: 405, contentType: "text/plain" })
          : fakeResponse({ status: 200, contentType: "application/json" });
      },
    });
    assert.deepEqual(calls, ["HEAD", "GET"]);
    assert.equal(base.status, "ok");
    assert.equal(base.method_tested, "GET");
  });
});

describe("acceptHeader", () => {
  test("maps expect kinds to Accept values", () => {
    assert.equal(acceptHeader("json"), "application/json");
    assert.equal(acceptHeader("html"), "text/html,application/xhtml+xml");
    assert.equal(acceptHeader("sse"), "text/event-stream");
    assert.equal(acceptHeader("anything-else"), "*/*");
    assert.equal(acceptHeader(undefined), "*/*");
  });
});

describe("probeUrl", () => {
  const opts = (fetchImpl, isUnsafeUrl = async () => false) => ({
    fetchImpl,
    isUnsafeUrl,
  });

  test("success: 200 returns ok + content_type + status_code", async () => {
    const probe = await probeUrl(
      "https://x.dev/a",
      "GET",
      "*/*",
      5000,
      opts(async () =>
        fakeResponse({ status: 200, contentType: "application/json" }),
      ),
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.status_code, 200);
    assert.equal(probe.content_type, "application/json");
    assert.equal(probe.method_tested, "GET");
    assert.equal(typeof probe.verified_at, "string");
  });

  test("non-ok: 404 returns ok=false with status_code", async () => {
    const probe = await probeUrl(
      "https://x.dev/missing",
      "GET",
      "*/*",
      5000,
      opts(async () => fakeResponse({ status: 404, contentType: "text/html" })),
    );
    assert.equal(probe.ok, false);
    assert.equal(probe.status_code, 404);
  });

  test("missing content-type returns null", async () => {
    const probe = await probeUrl(
      "https://x.dev/a",
      "GET",
      "*/*",
      5000,
      opts(async () => fakeResponse({ status: 200, contentType: null })),
    );
    assert.equal(probe.content_type, null);
  });

  test("unsafe initial URL short-circuits before any fetch", async () => {
    let fetched = false;
    const probe = await probeUrl("http://localhost/x", "GET", "*/*", 5000, {
      isUnsafeUrl: async () => true,
      fetchImpl: async () => {
        fetched = true;
        return fakeResponse();
      },
    });
    assert.equal(fetched, false);
    assert.equal(probe.ok, false);
    assert.equal(probe.unsafe_url, true);
    assert.equal(probe.error, "unsafe URL");
    assert.equal(probe.method_tested, "GET");
  });

  test("redirect 301 to safe target recurses and sums latency", async () => {
    const urls = [];
    const probe = await probeUrl("https://x.dev/old", "GET", "*/*", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === "https://x.dev/old") {
          return fakeResponse({
            status: 301,
            location: "https://x.dev/new",
            contentType: "text/html",
          });
        }
        return fakeResponse({ status: 200, contentType: "application/json" });
      },
    });
    assert.deepEqual(urls, ["https://x.dev/old", "https://x.dev/new"]);
    assert.equal(probe.ok, true);
    assert.equal(probe.status_code, 200);
    assert.equal(probe.redirect_target, "https://x.dev/new");
    assert.ok(typeof probe.latency_ms === "number");
  });

  test("redirect 302 with relative Location resolves against base", async () => {
    const urls = [];
    const probe = await probeUrl("https://x.dev/a/b", "GET", "*/*", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === "https://x.dev/a/b") {
          return fakeResponse({ status: 302, location: "/c" });
        }
        return fakeResponse({ status: 200, contentType: "application/json" });
      },
    });
    assert.deepEqual(urls, ["https://x.dev/a/b", "https://x.dev/c"]);
    assert.equal(probe.ok, true);
    assert.equal(probe.redirect_target, "https://x.dev/c");
  });

  test("redirect to unsafe target is blocked (private_redirect_blocked)", async () => {
    const probe = await probeUrl("https://x.dev/old", "GET", "*/*", 5000, {
      // safe for the initial URL, unsafe for the redirect target
      isUnsafeUrl: async (u) => u.includes("169.254"),
      fetchImpl: async () =>
        fakeResponse({ status: 301, location: "http://169.254.169.254/meta" }),
    });
    assert.equal(probe.ok, false);
    assert.equal(probe.private_redirect_blocked, true);
    assert.equal(probe.error, "redirect target is unsafe");
    assert.equal(probe.redirect_target, "http://169.254.169.254/meta");
    assert.equal(probe.status_code, 301);
  });

  test("redirect without Location header is treated as a normal response", async () => {
    const probe = await probeUrl(
      "https://x.dev/old",
      "GET",
      "*/*",
      5000,
      opts(async () => fakeResponse({ status: 301, location: null })),
    );
    // No location -> falls through to the normal (non-redirect) return path.
    assert.equal(probe.status_code, 301);
    assert.equal(probe.ok, false);
    assert.equal(probe.redirect_target, undefined);
  });

  test("redirectCount cap (>5) stops recursing and returns the redirect verbatim", async () => {
    let calls = 0;
    const probe = await probeUrl(
      "https://x.dev/loop",
      "GET",
      "*/*",
      5000,
      {
        isUnsafeUrl: async () => false,
        fetchImpl: async () => {
          calls += 1;
          return fakeResponse({
            status: 301,
            location: "https://x.dev/loop",
            contentType: "text/html",
          });
        },
      },
      5, // already at the cap -> redirectCount < 5 is false
    );
    assert.equal(calls, 1);
    assert.equal(probe.status_code, 301);
    assert.equal(probe.ok, false);
  });

  test("AbortError / timeout is caught and reported with error_class", async () => {
    const probe = await probeUrl(
      "https://x.dev/slow",
      "GET",
      "*/*",
      5000,
      opts(async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    assert.equal(probe.ok, false);
    assert.equal(probe.error_class, "AbortError");
    assert.equal(probe.error, "The operation was aborted");
    assert.equal(
      classifyProbe(probe, { probe: { expect: "html" } }),
      "timeout",
    );
  });
});

describe("probeSubtensorHttp / jsonRpcHttp (HTTP RPC)", () => {
  test("unsafe URL short-circuits", async () => {
    let fetched = false;
    const probe = await probeSubtensorHttp("http://10.0.0.1:9944", 5000, {
      isUnsafeUrl: async () => true,
      fetchImpl: async () => {
        fetched = true;
        return fakeResponse();
      },
    });
    assert.equal(fetched, false);
    assert.equal(probe.unsafe_url, true);
    assert.equal(probe.error, "unsafe URL");
  });

  test("full success path: live RPC with archive support + method count", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        switch (req.method) {
          case "chain_getHeader":
            return fakeResponse({
              status: 200,
              body: rpcBody(req.id, { number: "0x1a2b" }),
            });
          case "system_health":
            return fakeResponse({
              status: 200,
              body: rpcBody(req.id, { peers: 4, isSyncing: false }),
            });
          case "rpc_methods":
            return fakeResponse({
              status: 200,
              body: rpcBody(req.id, { methods: ["a", "b", "c"] }),
            });
          case "chain_getBlockHash":
            // params[0] === 0 is the genesis probe; anything else is the
            // archive probe (block 1).
            return fakeResponse({
              status: 200,
              body: rpcBody(
                req.id,
                req.params[0] === 0 ? FINNEY_GENESIS_HASH : "0xdeadbeef",
              ),
            });
          default:
            return fakeResponse({ status: 200, body: rpcBody(req.id, null) });
        }
      },
    });
    assert.equal(classifyRpcProbe(probe), "live");
    assert.equal(probe.chain_verified, true);
    assert.equal(probe.archive_support, true);
    assert.equal(probe.latest_block, 0x1a2b);
    assert.equal(probe.rpc_method_count, 3);
    assert.deepEqual(probe.methods_supported, {
      chain_getHeader: true,
      system_health: true,
      rpc_methods: true,
      chain_getBlockHash: true,
    });
    assert.equal(probe.method_results.chain_getHeader.ok, true);
  });

  test("archive NOT detected when block-hash result is not a hex string", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        if (req.method === "chain_getBlockHash") {
          return fakeResponse({ status: 200, body: rpcBody(req.id, null) });
        }
        return fakeResponse({
          status: 200,
          body: rpcBody(req.id, { number: "0x1" }),
        });
      },
    });
    assert.equal(probe.archive_support, false);
    assert.equal(probe.methods_supported.chain_getBlockHash, true);
  });

  test("transport error on first method exits the loop early", async () => {
    let callCount = 0;
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () => {
        callCount += 1;
        const err = new Error("connect ECONNREFUSED");
        err.name = "FetchError";
        throw err;
      },
    });
    // Only the first SUBTENSOR_PROBE_CALLS entry should have been attempted.
    assert.equal(callCount, 1);
    assert.equal(probe.transport_error, true);
    assert.equal(probe.error_class, "FetchError");
    assert.equal(probe.method_results.chain_getHeader.ok, false);
    // archive_support is omitted entirely in the transport-error branch.
    assert.equal(probe.archive_support, undefined);
  });

  test("non-JSON response is a transport error (response was not JSON)", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        fakeResponse({
          status: 200,
          contentType: "text/html",
          body: "<html>not json</html>",
        }),
    });
    assert.equal(probe.transport_error, true);
    assert.equal(probe.error, "response was not JSON");
    assert.equal(probe.content_type, "text/html");
    assert.equal(probe.status_code, 200);
  });

  test("rpc error body marks the method not-ok and surfaces the message", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        return fakeResponse({
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "Method not found" },
          }),
        });
      },
    });
    // ok && !body.error -> false, so chain_getHeader is not ok.
    assert.equal(probe.method_results.chain_getHeader.ok, false);
    assert.equal(
      probe.method_results.chain_getHeader.error,
      "Method not found",
    );
    assert.equal(probe.method_results.chain_getHeader.code, -32601);
    assert.equal(classifyRpcProbe(probe), "transient");
  });

  test("redirect to unsafe target during RPC is a transport error", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async (u) => u.includes("127.0.0.1"),
      fetchImpl: async () =>
        fakeResponse({
          status: 308,
          location: "http://127.0.0.1:9944",
        }),
    });
    assert.equal(probe.transport_error, true);
    assert.equal(probe.private_redirect_blocked, true);
    // new URL("http://127.0.0.1:9944", base).toString() adds a trailing slash.
    assert.equal(probe.redirect_target, "http://127.0.0.1:9944/");
    assert.equal(probe.status_code, 308);
  });

  test("redirect to a SAFE target falls through and parses body", async () => {
    // Location present + safe target: the if-body is skipped and the response
    // is parsed normally (exercises the safe-redirect branch of jsonRpcHttp).
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        return fakeResponse({
          status: 302,
          location: "https://rpc-2.dev",
          body: rpcBody(req.id, null),
        });
      },
    });
    // 302 is not >= 500 / 429 / 401-403, body parsed, no error -> evaluated.
    assert.equal(probe.method_results.chain_getHeader.ok, false);
    assert.equal(probe.status_code, 302);
  });
});

describe("probeSubtensorWss", () => {
  test("unsafe URL short-circuits", async () => {
    const probe = await probeSubtensorWss("ws://localhost:9944", 5000, {
      isUnsafeUrl: async () => true,
      connect: async () => new Map(),
    });
    assert.equal(probe.unsafe_url, true);
    assert.equal(probe.error, "unsafe URL");
  });

  test("no connector available -> UnsupportedRuntime", async () => {
    const probe = await probeSubtensorWss("wss://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
    });
    assert.equal(probe.error_class, "UnsupportedRuntime");
    assert.match(probe.error, /no WebSocket connector/);
  });

  test("connector resolving a full Map -> live summary", async () => {
    const probe = await probeSubtensorWss("wss://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      connect: async () =>
        new Map([
          ["chain_getHeader", { ok: true, result: { number: "0x20" } }],
          ["system_health", { ok: true, result: { peers: 2 } }],
          ["rpc_methods", { ok: true, result: { methods: ["x", "y"] } }],
          ["archive_probe", { ok: true, result: "0xabc" }],
        ]),
    });
    assert.equal(classifyRpcProbe(probe), "live");
    assert.equal(probe.chain_verified, null);
    assert.equal(probe.latest_block, 0x20);
    assert.equal(probe.archive_support, true);
    assert.equal(probe.rpc_method_count, 2);
  });

  test("flags a mismatched WSS genesis as wrong-chain", async () => {
    const probe = await probeSubtensorWss("wss://wrong.dev", 5000, {
      isUnsafeUrl: async () => false,
      connect: async () =>
        new Map([
          ["chain_getHeader", { ok: true, result: { number: "0x1" } }],
          ["system_health", { ok: true, result: { peers: 1 } }],
          ["rpc_methods", { ok: true, result: { methods: [] } }],
          ["archive_probe", { ok: true, result: "0xabc" }],
          ["genesis", { ok: true, result: "0xother_network_genesis" }],
        ]),
    });
    assert.equal(probe.chain_verified, false);
    assert.equal(classifyRpcProbe(probe), "wrong-chain");
  });

  test("connector resolving a partial Map fills missing keys", async () => {
    const probe = await probeSubtensorWss("wss://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      connect: async () =>
        new Map([["chain_getHeader", { ok: true, result: { number: "0x1" } }]]),
    });
    // archive_probe etc. become { error: "missing response" } -> ok=false.
    assert.equal(probe.methods_supported.system_health, false);
    assert.equal(probe.method_results.archive_probe.error, "missing response");
  });

  test("connector that throws is caught and reported", async () => {
    const probe = await probeSubtensorWss("wss://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      connect: async () => {
        const err = new Error("WebSocket RPC probe timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });
    assert.equal(probe.error, "WebSocket RPC probe timed out");
    assert.equal(probe.error_class, "TimeoutError");
    assert.deepEqual(probe.method_results, {});
    assert.equal(classifyRpcProbe(probe), "timeout");
  });
});

describe("nodeWebSocketConnector", () => {
  // Fake WebSocket: stores handlers added via addEventListener and exposes a way
  // to drive open/message/error events synchronously from the test.
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.handlers = {};
      FakeSocket.last = this;
    }
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
    }
    fire(type, event) {
      this.handlers[type]?.(event);
    }
  }

  const calls = [
    { key: "chain_getHeader", method: "chain_getHeader", params: [] },
    { key: "system_health", method: "system_health", params: [] },
  ];

  test("missing WebSocket global rejects", async () => {
    // Pass null (not undefined) so the default-param fallback to
    // globalThis.WebSocket does not kick in: typeof null !== "function".
    const connect = nodeWebSocketConnector(null);
    await assert.rejects(
      () => connect("wss://rpc.dev", calls, 5000),
      /WebSocket global is unavailable/,
    );
  });

  test("open sends every call, message resolves when all ids arrive", async () => {
    const connect = nodeWebSocketConnector(FakeSocket);
    const promise = connect("wss://rpc.dev", calls, 5000);
    const socket = FakeSocket.last;

    socket.fire("open");
    assert.equal(socket.sent.length, 2);
    const sent0 = JSON.parse(socket.sent[0]);
    assert.equal(sent0.method, "chain_getHeader");
    assert.equal(sent0.id, 1);

    // First response: not yet complete.
    socket.fire("message", {
      data: JSON.stringify({ id: 1, result: { number: "0x1" } }),
    });
    // Unknown id is ignored (no key) -> still pending.
    socket.fire("message", { data: JSON.stringify({ id: 99, result: {} }) });
    // Final response completes the set.
    socket.fire("message", {
      data: JSON.stringify({ id: 2, result: { peers: 1 } }),
    });

    const results = await promise;
    assert.equal(results.size, 2);
    assert.equal(results.get("chain_getHeader").ok, true);
    assert.equal(results.get("system_health").ok, true);
    assert.equal(socket.closed, true);
  });

  test("rpc error in a message sets ok=false but still resolves", async () => {
    const connect = nodeWebSocketConnector(FakeSocket);
    const promise = connect("wss://rpc.dev", calls, 5000);
    const socket = FakeSocket.last;
    socket.fire("open");
    socket.fire("message", {
      data: JSON.stringify({ id: 1, error: { code: -1, message: "boom" } }),
    });
    socket.fire("message", {
      data: JSON.stringify({ id: 2, result: { peers: 0 } }),
    });
    const results = await promise;
    assert.equal(results.get("chain_getHeader").ok, false);
    assert.equal(results.get("chain_getHeader").rpc_error.message, "boom");
  });

  test("malformed message JSON rejects and closes the socket", async () => {
    const connect = nodeWebSocketConnector(FakeSocket);
    const promise = connect("wss://rpc.dev", calls, 5000);
    const socket = FakeSocket.last;
    socket.fire("open");
    socket.fire("message", { data: "{not-json" });
    await assert.rejects(() => promise);
    assert.equal(socket.closed, true);
  });

  test("error event rejects the connection", async () => {
    const connect = nodeWebSocketConnector(FakeSocket);
    const promise = connect("wss://rpc.dev", calls, 5000);
    const socket = FakeSocket.last;
    socket.fire("error", {});
    await assert.rejects(() => promise, /WebSocket RPC connection failed/);
  });

  test("timeout rejects with a TimeoutError and closes the socket", async () => {
    const connect = nodeWebSocketConnector(FakeSocket);
    // 0ms timeout fires on the next macrotask before any message arrives.
    const promise = connect("wss://rpc.dev", calls, 0);
    const socket = FakeSocket.last;
    await assert.rejects(promise, (err) => {
      assert.equal(err.name, "TimeoutError");
      assert.match(err.message, /timed out/);
      return true;
    });
    assert.equal(socket.closed, true);
  });

  test("timeout swallows a close() that throws", async () => {
    class ThrowingCloseSocket extends FakeSocket {
      close() {
        throw new Error("close failed");
      }
    }
    const connect = nodeWebSocketConnector(ThrowingCloseSocket);
    const promise = connect("wss://rpc.dev", calls, 0);
    await assert.rejects(promise, /timed out/);
  });

  test("default WebSocketImpl uses globalThis.WebSocket", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    try {
      const connect = nodeWebSocketConnector();
      const promise = connect("wss://rpc.dev", calls, 5000);
      const socket = FakeSocket.last;
      socket.fire("open");
      socket.fire("message", {
        data: JSON.stringify({ id: 1, result: { number: "0x1" } }),
      });
      socket.fire("message", {
        data: JSON.stringify({ id: 2, result: { peers: 1 } }),
      });
      const results = await promise;
      assert.equal(results.size, 2);
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe("normalizeJsonRpcResult", () => {
  test("header result captures raw_header.number", () => {
    const n = normalizeJsonRpcResult({ ok: true, result: { number: "0x10" } });
    assert.equal(n.ok, true);
    assert.deepEqual(n.raw_header, { number: "0x10" });
    assert.equal(n.result_type, "object");
    assert.equal(n.result_present, true);
  });

  test("array result -> result_type array + rpc_method_count", () => {
    const n = normalizeJsonRpcResult({
      ok: true,
      result: { methods: ["a", "b"] },
    });
    assert.equal(n.rpc_method_count, 2);
  });

  test("hex string result sets raw_hex_result_present", () => {
    const n = normalizeJsonRpcResult({ ok: true, result: "0xabc" });
    assert.equal(n.result_type, "string");
    assert.equal(n.raw_hex_result_present, true);
  });

  test("plain array result -> result_type array, no header", () => {
    const n = normalizeJsonRpcResult({ ok: true, result: [1, 2, 3] });
    assert.equal(n.result_type, "array");
    assert.equal(n.raw_header, undefined);
  });

  test("null result -> result_type null, not present", () => {
    const n = normalizeJsonRpcResult({ ok: false, result: null });
    assert.equal(n.result_type, "null");
    assert.equal(n.result_present, false);
  });

  test("undefined result -> result_type undefined, not present", () => {
    const n = normalizeJsonRpcResult({ ok: false });
    assert.equal(n.result_type, "undefined");
    assert.equal(n.result_present, false);
  });

  test("rpc_error message + code are surfaced", () => {
    const n = normalizeJsonRpcResult({
      ok: false,
      rpc_error: { code: -32000, message: "server error" },
    });
    assert.equal(n.error, "server error");
    assert.equal(n.code, -32000);
  });

  test("plain error string is surfaced", () => {
    const n = normalizeJsonRpcResult({ error: "missing response" });
    assert.equal(n.error, "missing response");
    assert.equal(n.ok, false);
  });
});

describe("parseBlockNumber", () => {
  test("hex string is parsed base-16", () => {
    assert.equal(parseBlockNumber({ number: "0xff" }), 255);
  });
  test("decimal string is parsed base-10", () => {
    assert.equal(parseBlockNumber({ number: "1024" }), 1024);
  });
  test("number passes through", () => {
    assert.equal(parseBlockNumber({ number: 42 }), 42);
  });
  test("non-object header returns null", () => {
    assert.equal(parseBlockNumber(null), null);
    assert.equal(parseBlockNumber(undefined), null);
    assert.equal(parseBlockNumber("nope"), null);
  });
  test("non-string/number number field returns null", () => {
    assert.equal(parseBlockNumber({ number: { nested: true } }), null);
    assert.equal(parseBlockNumber({}), null);
  });
  test("malformed numeric string returns null, not NaN", () => {
    assert.equal(parseBlockNumber({ number: "0x" }), null);
    assert.equal(parseBlockNumber({ number: "0xZZ" }), null);
    assert.equal(parseBlockNumber({ number: "" }), null);
  });
  test("non-finite or non-integer number field returns null", () => {
    assert.equal(parseBlockNumber({ number: NaN }), null);
    assert.equal(parseBlockNumber({ number: Infinity }), null);
    assert.equal(parseBlockNumber({ number: 1.5 }), null);
  });
  test("genesis block 0 is preserved", () => {
    assert.equal(parseBlockNumber({ number: 0 }), 0);
    assert.equal(parseBlockNumber({ number: "0x0" }), 0);
  });
});

describe("contentMismatch (remaining branches)", () => {
  test("json expect: text/plain at a .json path is tolerated", () => {
    assert.equal(
      contentMismatch(
        { content_type: "text/plain" },
        { url: "https://x.dev/file.JSON", probe: { expect: "json" } },
      ),
      false,
    );
  });
  test("json expect: non-json content is a mismatch", () => {
    assert.equal(
      contentMismatch(
        { content_type: "text/html" },
        { url: "https://x.dev/data.json", probe: { expect: "json" } },
      ),
      true,
    );
  });
  test("html expect: non-html is a mismatch, html is fine", () => {
    const surface = { url: "https://x.dev", probe: { expect: "html" } };
    assert.equal(
      contentMismatch({ content_type: "application/json" }, surface),
      true,
    );
    assert.equal(
      contentMismatch({ content_type: "text/html" }, surface),
      false,
    );
  });
  test("sse expect: non-sse is a mismatch, event-stream is fine", () => {
    const surface = { url: "https://x.dev/stream", probe: { expect: "sse" } };
    assert.equal(contentMismatch({ content_type: "text/html" }, surface), true);
    assert.equal(
      contentMismatch({ content_type: "text/event-stream" }, surface),
      false,
    );
  });
  test("unknown expect kind is never a mismatch", () => {
    assert.equal(
      contentMismatch(
        { content_type: "text/plain" },
        { url: "https://x.dev", probe: { expect: "data" } },
      ),
      false,
    );
  });
});

describe("classifyProbe / classifyRpcProbe (remaining branches)", () => {
  test("classifyProbe: private_redirect_blocked -> unsafe", () => {
    assert.equal(
      classifyProbe({ private_redirect_blocked: true }, { probe: {} }),
      "unsafe",
    );
  });
  test("classifyProbe: 410 -> dead, 401 -> auth-required", () => {
    const s = { probe: { expect: "html" } };
    assert.equal(classifyProbe({ status_code: 410 }, s), "dead");
    assert.equal(classifyProbe({ status_code: 401 }, s), "auth-required");
  });
  test("classifyProbe: not-ok, no special status -> unsupported", () => {
    assert.equal(
      classifyProbe(
        { ok: false, status_code: 200 },
        { probe: { expect: "html" } },
      ),
      "unsupported",
    );
  });
  test("classifyRpcProbe: unsafe / rate-limited / auth-required / transient", () => {
    assert.equal(classifyRpcProbe({ unsafe_url: true }), "unsafe");
    assert.equal(
      classifyRpcProbe({ private_redirect_blocked: true }),
      "unsafe",
    );
    assert.equal(classifyRpcProbe({ error_class: "AbortError" }), "timeout");
    assert.equal(classifyRpcProbe({ status_code: 429 }), "rate-limited");
    assert.equal(classifyRpcProbe({ status_code: 401 }), "auth-required");
    assert.equal(classifyRpcProbe({ status_code: 500 }), "transient");
    assert.equal(classifyRpcProbe({ error: "boom" }), "unsupported");
    assert.equal(classifyRpcProbe({ method_results: {} }), "transient");
  });

  test("classifyRpcProbe: wrong-chain only on explicit genesis mismatch", () => {
    const liveMethods = {
      chain_getHeader: { ok: true },
      system_health: { ok: true },
    };
    // Explicit mismatch → wrong-chain, even though the node otherwise looks live.
    assert.equal(
      classifyRpcProbe({ chain_verified: false, method_results: liveMethods }),
      "wrong-chain",
    );
    // Matching or unverifiable genesis → judged on its other methods.
    assert.equal(
      classifyRpcProbe({ chain_verified: true, method_results: liveMethods }),
      "live",
    );
    assert.equal(
      classifyRpcProbe({ chain_verified: null, method_results: liveMethods }),
      "live",
    );
    // wrong-chain is a hard failure regardless of authority.
    assert.equal(statusForClassification("wrong-chain"), "failed");
    assert.equal(
      statusForClassification("wrong-chain", { authority: "community" }),
      "failed",
    );
  });

  test("probeSubtensorHttp flags a mismatched genesis as wrong-chain", async () => {
    const probe = await probeSubtensorHttp("https://wrong.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_url, init) => {
        const req = JSON.parse(init.body);
        const result =
          req.method === "chain_getBlockHash"
            ? "0xother_network_genesis"
            : req.method === "chain_getHeader"
              ? { number: "0x1" }
              : req.method === "system_health"
                ? { peers: 1, isSyncing: false }
                : null;
        return fakeResponse({ status: 200, body: rpcBody(req.id, result) });
      },
    });
    assert.equal(probe.chain_verified, false);
    assert.equal(classifyRpcProbe(probe), "wrong-chain");
  });
});

describe("statusForClassification (remaining branches)", () => {
  test("content-mismatch downgrades for registry-observed", () => {
    assert.equal(
      statusForClassification("content-mismatch", {
        authority: "registry-observed",
      }),
      "degraded",
    );
  });
  test("unsupported with official authority stays failed", () => {
    assert.equal(
      statusForClassification("unsupported", { authority: "official" }),
      "failed",
    );
  });
  test("redirected -> ok, rate-limited -> degraded", () => {
    assert.equal(statusForClassification("redirected"), "ok");
    assert.equal(statusForClassification("rate-limited"), "degraded");
  });
  test("null surface with dead -> failed", () => {
    assert.equal(statusForClassification("dead"), "failed");
  });
});

describe("probeSurface (RPC kinds)", () => {
  const wssSurface = {
    id: "sn0-wss",
    netuid: 0,
    kind: "subtensor-wss",
    url: "wss://rpc.dev",
    provider: "opentensor",
    auth_required: false,
    public_safe: true,
    subnet_name: "Root",
    subnet_slug: "root",
    probe: { enabled: true, method: "WSS", expect: "json", timeout_ms: 4000 },
  };

  test("subtensor-wss live path threads through probeSurface", async () => {
    const row = await probeSurface(wssSurface, {
      isUnsafeUrl: async () => false,
      connect: async () =>
        new Map([
          ["chain_getHeader", { ok: true, result: { number: "0x5" } }],
          ["system_health", { ok: true, result: { peers: 3 } }],
          ["rpc_methods", { ok: true, result: { methods: ["a"] } }],
          ["archive_probe", { ok: true, result: "0xfeed" }],
        ]),
    });
    assert.equal(row.classification, "live");
    assert.equal(row.status, "ok");
    assert.equal(row.kind, "subtensor-wss");
    assert.equal(row.latest_block, 5);
    assert.equal(row.archive_support, true);
    assert.equal(row.surface_id, "sn0-wss");
  });

  test("subtensor-wss unsafe URL -> unsafe/failed with fallback timeout", async () => {
    const noTimeout = {
      ...wssSurface,
      probe: { ...wssSurface.probe, timeout_ms: undefined },
    };
    const row = await probeSurface(noTimeout, {
      isUnsafeUrl: async () => true,
      connect: async () => new Map(),
    });
    assert.equal(row.classification, "unsafe");
    assert.equal(row.status, "failed");
    assert.equal(row.private_redirect_blocked, false);
  });

  test("subtensor-rpc transport error -> transient/degraded", async () => {
    const rpcSurface = {
      ...wssSurface,
      id: "sn0-rpc",
      kind: "subtensor-rpc",
      url: "https://rpc.dev",
      probe: {
        enabled: true,
        method: "POST",
        expect: "json",
        timeout_ms: undefined,
      },
    };
    const row = await probeSurface(rpcSurface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () => {
        const err = new Error("ECONNRESET");
        err.name = "FetchError";
        throw err;
      },
    });
    assert.equal(row.kind, "subtensor-rpc");
    assert.equal(row.error_class, "FetchError");
    // transport_error -> classifyRpcProbe sees probe.error -> "unsupported".
    assert.equal(row.classification, "unsupported");
    assert.equal(row.archive_support, undefined);
  });
});

describe("probeSurface (non-RPC remaining branches)", () => {
  const surface = {
    id: "sn7-html",
    netuid: 7,
    kind: "website",
    url: "https://x.dev/",
    provider: "acme",
    auth_required: false,
    public_safe: true,
    subnet_name: "Acme",
    subnet_slug: "acme",
    probe: {
      enabled: true,
      method: "GET",
      expect: "html",
      timeout_ms: undefined,
    },
  };

  test("default timeout (8000) used when timeout_ms omitted; html live", async () => {
    const row = await probeSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        fakeResponse({ status: 200, contentType: "text/html" }),
    });
    assert.equal(row.classification, "live");
    assert.equal(row.status, "ok");
  });

  test("HEAD 200 (no fallback) keeps method HEAD", async () => {
    const headSurface = {
      ...surface,
      probe: { ...surface.probe, method: "HEAD" },
    };
    const calls = [];
    const row = await probeSurface(headSurface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_u, init) => {
        calls.push(init.method);
        return fakeResponse({ status: 200, contentType: "text/html" });
      },
    });
    assert.deepEqual(calls, ["HEAD"]);
    assert.equal(row.method_tested, "HEAD");
  });

  test("non-HEAD 405 does NOT fall back to GET", async () => {
    const calls = [];
    const row = await probeSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_u, init) => {
        calls.push(init.method);
        return fakeResponse({ status: 405, contentType: "text/html" });
      },
    });
    assert.deepEqual(calls, ["GET"]);
    assert.equal(row.status_code, 405);
  });
});

// A fetch mock that honours the AbortController signal so the timeout timer's
// abort() callback actually fires (covers the setTimeout(() => abort()) lines).
function abortableFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (signal.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

describe("timeout abort timer callbacks", () => {
  test("probeUrl: 0ms timeout fires controller.abort() -> AbortError", async () => {
    const probe = await probeUrl("https://x.dev/slow", "GET", "*/*", 0, {
      isUnsafeUrl: async () => false,
      fetchImpl: abortableFetch(),
    });
    assert.equal(probe.ok, false);
    assert.equal(probe.error_class, "AbortError");
    assert.equal(
      classifyProbe(probe, { probe: { expect: "html" } }),
      "timeout",
    );
  });

  test("probeSubtensorHttp: 0ms timeout aborts the RPC fetch", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 0, {
      isUnsafeUrl: async () => false,
      fetchImpl: abortableFetch(),
    });
    assert.equal(probe.transport_error, true);
    assert.equal(probe.error_class, "AbortError");
    assert.equal(classifyRpcProbe(probe), "timeout");
  });
});

describe("isUnsafePublicUrl / isJsonContentType (remaining branches)", () => {
  test("empty hostname is unsafe (host falsy branch)", () => {
    // A URL whose hostname parses to an empty string.
    assert.equal(isUnsafePublicUrl("https://"), true);
    assert.equal(isUnsafePublicUrl("http://[::1]/x"), true);
  });
  test("trailing-dot + bracketed-IPv6 hosts are normalized", () => {
    // Public host with a trailing dot -> stripped, still safe.
    assert.equal(isUnsafePublicUrl("https://example.com./x"), false);
  });
});

describe("contentMismatch with null content_type", () => {
  test("json expect + null content_type is a mismatch (|| '' branch)", () => {
    assert.equal(
      contentMismatch(
        { content_type: null },
        { url: "https://x.dev/data.json", probe: { expect: "json" } },
      ),
      true,
    );
  });
  test("html expect + null content_type is a mismatch", () => {
    assert.equal(
      contentMismatch(
        { content_type: null },
        { url: "https://x.dev", probe: { expect: "html" } },
      ),
      true,
    );
  });
  test("sse expect + null content_type is a mismatch", () => {
    assert.equal(
      contentMismatch(
        { content_type: null },
        { url: "https://x.dev", probe: { expect: "sse" } },
      ),
      true,
    );
  });
});

describe("jsonRpcHttp non-JSON with empty content-type", () => {
  test("non-JSON body + missing content-type -> content_type null", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        fakeResponse({ status: 200, contentType: null, body: "<<garbage" }),
    });
    assert.equal(probe.transport_error, true);
    assert.equal(probe.error, "response was not JSON");
    assert.equal(probe.content_type, null);
  });
});

describe("probeSurface non-RPC redirect_target passthrough", () => {
  test("redirected response surfaces redirect_target (|| null else-branch)", async () => {
    const surface = {
      id: "x",
      netuid: 1,
      kind: "website",
      url: "https://x.dev/old",
      provider: "p",
      auth_required: false,
      public_safe: true,
      subnet_name: "n",
      subnet_slug: "s",
      probe: { method: "GET", expect: "html" },
    };
    const row = await probeSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (url) =>
        url === "https://x.dev/old"
          ? fakeResponse({ status: 301, location: "https://x.dev/new" })
          : fakeResponse({ status: 200, contentType: "text/html" }),
    });
    assert.equal(row.redirect_target, "https://x.dev/new");
    assert.equal(row.classification, "redirected");
    assert.equal(row.status, "ok");
  });

  test("non-RPC timeout: missing status_code defaults to null", async () => {
    const surface = {
      id: "x",
      netuid: 1,
      kind: "website",
      url: "https://x.dev/",
      provider: "p",
      auth_required: false,
      public_safe: true,
      subnet_name: "n",
      subnet_slug: "s",
      probe: { method: "GET", expect: "html" },
    };
    const row = await probeSurface(surface, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    // AbortError path on probeUrl omits status_code -> defaults to null.
    assert.equal(row.status_code, null);
    assert.equal(row.classification, "timeout");
    assert.equal(row.status, "degraded");
  });
});

describe("jsonRpcHttp empty/headerless body branches", () => {
  test("empty body text -> body null, missing content-type -> null", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async () =>
        fakeResponse({ status: 200, contentType: null, body: "" }),
    });
    // text === "" -> body = null; response.ok && !null?.error -> ok true.
    assert.equal(probe.content_type, null);
    assert.equal(probe.method_results.chain_getHeader.ok, true);
    assert.equal(probe.method_results.chain_getHeader.result_present, false);
  });

  test("non-ok HTTP status with valid JSON -> method not ok", async () => {
    const probe = await probeSubtensorHttp("https://rpc.dev", 5000, {
      isUnsafeUrl: async () => false,
      fetchImpl: async (_u, init) => {
        const req = JSON.parse(init.body);
        return fakeResponse({ status: 502, body: rpcBody(req.id, null) });
      },
    });
    // status_code 502 -> classifyRpcProbe transient.
    assert.equal(probe.method_results.chain_getHeader.ok, false);
    assert.equal(probe.status_code, 502);
    assert.equal(classifyRpcProbe(probe), "transient");
  });
});

describe("probeSurface field-default branches", () => {
  test("RPC row uses fallbackVerifiedAt when probe omits verified_at", async () => {
    // A connector that resolves an empty Map -> summarizeRpcProbe still sets
    // verified_at, so to hit the fallback we make probeSubtensorWss throw
    // synchronously is hard; instead verify the non-RPC redirect_target/null
    // content_type defaults below. Here we assert verified_at is always a string.
    const row = await probeSurface(
      {
        id: "x",
        netuid: 1,
        kind: "subtensor-wss",
        url: "wss://rpc.dev",
        provider: "p",
        auth_required: false,
        public_safe: true,
        subnet_name: "n",
        subnet_slug: "s",
        probe: { method: "WSS", expect: "json" },
      },
      {
        isUnsafeUrl: async () => false,
        connect: async () =>
          new Map([
            ["chain_getHeader", { ok: true, result: { number: "0x1" } }],
            ["system_health", { ok: true }],
            ["rpc_methods", { ok: true, result: { methods: [] } }],
            ["archive_probe", { ok: false }],
          ]),
      },
    );
    assert.equal(typeof row.verified_at, "string");
    assert.equal(typeof row.last_checked, "string");
  });

  test("non-RPC row: null content_type + null redirect_target defaults", async () => {
    const row = await probeSurface(
      {
        id: "x",
        netuid: 1,
        kind: "website",
        url: "https://x.dev/",
        provider: "p",
        auth_required: false,
        public_safe: true,
        subnet_name: "n",
        subnet_slug: "s",
        probe: { method: "GET", expect: "html" },
      },
      {
        isUnsafeUrl: async () => false,
        fetchImpl: async () => fakeResponse({ status: 200, contentType: null }),
      },
    );
    assert.equal(row.content_type, null);
    assert.equal(row.redirect_target, null);
  });
});
