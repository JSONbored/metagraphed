import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyProbe,
  classifyRpcProbe,
  contentMismatch,
  isUnsafePublicUrl,
  mapLimit,
  probeSurface,
  statusForClassification,
  summarizeRpcProbe,
} from "../src/health-probe-core.mjs";

// Minimal Response-like stub for an injected fetch.
function fakeResponse({
  status = 200,
  contentType = "application/json",
  body = "{}",
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        return null;
      },
    },
    body: { cancel: async () => {} },
    async text() {
      return body;
    },
  };
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

  test("allows public http(s)/ws(s)", () => {
    for (const url of [
      "https://entrypoint-finney.opentensor.ai",
      "http://example.com/api",
      "wss://lite.chain.opentensor.ai:443",
      "https://172.15.0.1/x", // just outside the private 172.16-31 range
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
