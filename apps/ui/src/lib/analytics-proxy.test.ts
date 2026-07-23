import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  ANALYTICS_PREFIX,
  handleAnalyticsProxy,
  retrieveAnalyticsAsset,
  forwardToAnalyticsHost,
} from "./analytics-proxy";

function fakeCtx(): { waitUntil: ReturnType<typeof vi.fn>; calls: Promise<unknown>[] } {
  const calls: Promise<unknown>[] = [];
  return { waitUntil: vi.fn((p: Promise<unknown>) => calls.push(p)), calls };
}

describe("handleAnalyticsProxy", () => {
  it("returns null for any request outside the prefix (falls through to the SSR app)", async () => {
    const request = new Request("https://metagraph.sh/subnets/7");
    await expect(handleAnalyticsProxy(request, fakeCtx())).resolves.toBeNull();
  });

  it(`does not treat "${ANALYTICS_PREFIX}" itself (no trailing path) as a match`, async () => {
    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}`);
    await expect(handleAnalyticsProxy(request, fakeCtx())).resolves.toBeNull();
  });
});

describe("forwardToAnalyticsHost", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards to PostHog's real API host, preserving the path and query", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      calls.push({ url: req.url });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const body = JSON.stringify({ event: "$pageview" });
    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/?ip=0`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    await forwardToAnalyticsHost(request, "/e/?ip=0");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://us.i.posthog.com/e/?ip=0");
  });

  it("sets x-forwarded-for from cf-connecting-ip and strips the request cookie header", async () => {
    let forwardedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      forwardedHeaders = (input as Request).headers;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        "cf-connecting-ip": "203.0.113.7",
        cookie: "session=super-secret",
      },
      body: "{}",
    });
    await forwardToAnalyticsHost(request, "/e/");

    expect(forwardedHeaders?.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(forwardedHeaders?.has("cookie")).toBe(false);
  });

  it("strips set-cookie from the response before returning it to the browser", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("ok", { status: 200, headers: { "set-cookie": "ph_x=y" } });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": "2" },
      body: "{}",
    });
    const response = await forwardToAnalyticsHost(request, "/e/");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("buffers a POST body rather than streaming it through unread", async () => {
    let bodyType: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      bodyType = typeof req.body;
      const buf = await req.arrayBuffer();
      expect(new TextDecoder().decode(buf)).toBe('{"event":"$pageview"}');
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const body = '{"event":"$pageview"}';
    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body,
    });
    await forwardToAnalyticsHost(request, "/e/");
    expect(bodyType).toBe("object");
  });

  it("rejects a POST with no content-length header (411), never buffering or forwarding it", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      body: "{}",
    });
    // jsdom/undici's Request doesn't auto-populate content-length for a
    // string body the way a real browser's wire-level HTTP request would
    // (verified against Node's native Request) -- this test exploits that
    // exact gap to exercise the "missing/unparseable" branch.
    const response = await forwardToAnalyticsHost(request, "/e/");

    expect(response.status).toBe(411);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a POST with a non-numeric content-length header (411)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "{}",
    });
    const response = await forwardToAnalyticsHost(request, "/e/");

    expect(response.status).toBe(411);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a POST whose content-length exceeds the ingest cap (413), never buffering or forwarding it", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": String(64 * 1024 + 1) },
      body: "{}",
    });
    const response = await forwardToAnalyticsHost(request, "/e/");

    expect(response.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a POST whose content-length is exactly at the ingest cap", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": String(64 * 1024) },
      body: "{}",
    });
    const response = await forwardToAnalyticsHost(request, "/e/");

    expect(response.status).toBe(200);
  });

  it("sends no body for GET/HEAD", async () => {
    let sawBody: unknown;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      sawBody = (input as Request).body;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/decide/`, {
      method: "GET",
    });
    await forwardToAnalyticsHost(request, "/decide/");
    expect(sawBody).toBeNull();
  });
});

describe("retrieveAnalyticsAsset", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // @ts-expect-error -- test-only cleanup of the ambient `caches` global.
    delete globalThis.caches;
  });

  it("fetches from PostHog's asset host when there is no edge cache available", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response("/* js */", { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    const response = await retrieveAnalyticsAsset(request, "/static/array.js", {
      waitUntil: vi.fn(),
    });
    expect(calls).toEqual(["https://us-assets.i.posthog.com/static/array.js"]);
    expect(response.status).toBe(200);
  });

  it("serves from the edge cache on a hit, without issuing a fetch", async () => {
    const cachedResponse = new Response("cached", { status: 200 });
    const match = vi.fn(async () => cachedResponse);
    const put = vi.fn(async () => {});
    // @ts-expect-error -- test-only stub of the ambient Cloudflare `caches` global.
    globalThis.caches = { default: { match, put } };
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    const response = await retrieveAnalyticsAsset(request, "/static/array.js", {
      waitUntil: vi.fn(),
    });
    expect(response).toBe(cachedResponse);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("populates the edge cache via ctx.waitUntil on a miss", async () => {
    const match = vi.fn(async () => undefined);
    const put = vi.fn(async () => {});
    // @ts-expect-error -- test-only stub of the ambient Cloudflare `caches` global.
    globalThis.caches = { default: { match, put } };
    globalThis.fetch = vi.fn(async () => new Response("/* js */", { status: 200 })) as typeof fetch;

    const ctx = fakeCtx();
    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    await retrieveAnalyticsAsset(request, "/static/array.js", ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(ctx.calls);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected cache.put() instead of leaking an unhandled rejection through ctx.waitUntil", async () => {
    // Regression test: a promise passed to ctx.waitUntil() that rejects
    // becomes an unhandled rejection at the Worker's global scope, which
    // Nitro/h3's own safety net (src/lib/error-capture.ts) turns into a
    // generic 500 for the CURRENT request -- even though the response this
    // function already returned was correct. Confirmed live in production
    // (every /ingest/static/* and /ingest/array/* request 500'd this way
    // before the .catch() below was added).
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const match = vi.fn(async () => undefined);
    const putError = new Error("cache.put: response contains an unsupported Vary header");
    const put = vi.fn(async () => {
      throw putError;
    });
    // @ts-expect-error -- test-only stub of the ambient Cloudflare `caches` global.
    globalThis.caches = { default: { match, put } };
    globalThis.fetch = vi.fn(async () => new Response("/* js */", { status: 200 })) as typeof fetch;

    const ctx = fakeCtx();
    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    const response = await retrieveAnalyticsAsset(request, "/static/array.js", ctx);

    // The response itself must be unaffected by the background failure.
    expect(response.status).toBe(200);
    // The promise handed to ctx.waitUntil must resolve, never reject --
    // this is the actual regression: a REJECTED promise there is what
    // corrupts the response via the global unhandled-rejection handler.
    await expect(Promise.all(ctx.calls)).resolves.toBeDefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[analytics-proxy] edge-cache put failed:",
      putError,
    );
    consoleErrorSpy.mockRestore();
  });

  it("degrades to an uncached passthrough fetch when ctx is undefined, instead of throwing", async () => {
    // Regression test for the actual confirmed root cause of the production
    // incident the two tests above were hardening against: `wrangler tail`
    // against the live Worker showed `ctx` itself arriving `undefined` for
    // this request path ("Cannot read properties of undefined (reading
    // 'waitUntil')"), not a Cache API rejection. server.ts's own `ctx:
    // unknown` parameter is cast, not runtime-checked, so this module can't
    // assume the type-level contract holds.
    const match = vi.fn(async () => undefined);
    const put = vi.fn(async () => {});
    // @ts-expect-error -- test-only stub of the ambient Cloudflare `caches` global.
    globalThis.caches = { default: { match, put } };
    globalThis.fetch = vi.fn(async () => new Response("/* js */", { status: 200 })) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    const response = await retrieveAnalyticsAsset(request, "/static/array.js", undefined);

    expect(response.status).toBe(200);
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("handleAnalyticsProxy routing", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // @ts-expect-error -- ensure no edge-cache global leaks between tests.
    delete globalThis.caches;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it(`routes ${ANALYTICS_PREFIX}/static/* to the asset host`, async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/static/array.js`);
    await handleAnalyticsProxy(request, fakeCtx());
    expect(calls[0]).toBe("https://us-assets.i.posthog.com/static/array.js");
  });

  it(`routes ${ANALYTICS_PREFIX}/array/* to the asset host`, async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/array/phc_test/config.js`);
    await handleAnalyticsProxy(request, fakeCtx());
    expect(calls[0]).toBe("https://us-assets.i.posthog.com/array/phc_test/config.js");
  });

  it(`routes ${ANALYTICS_PREFIX}/array/* correctly even when ctx is undefined (the confirmed production root cause)`, async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/array/phc_test/config.js`);
    const response = await handleAnalyticsProxy(request, undefined);
    expect(calls[0]).toBe("https://us-assets.i.posthog.com/array/phc_test/config.js");
    expect(response?.status).toBe(200);
  });

  it(`routes everything else under ${ANALYTICS_PREFIX} to the main API host`, async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push((input as Request).url);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const request = new Request(`https://metagraph.sh${ANALYTICS_PREFIX}/e/`, {
      method: "POST",
      headers: { "content-length": "2" },
      body: "{}",
    });
    await handleAnalyticsProxy(request, fakeCtx());
    expect(calls[0]).toBe("https://us.i.posthog.com/e/");
  });
});
