// The public self-health MISS advertised 60s while its byte-identical HIT
// advertised 4h. Exercise the cache boundary with rewritten native headers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { withStampedEdgeCache } from "../workers/edge-cache.ts";
import { envelopeResponse } from "../workers/responses.ts";
import { withNoStore } from "../workers/http.ts";

const CONTROL = "x-metagraph-stored-cache-control";
const EXPIRES = "x-metagraph-stored-expires";
const TARGET = "https://api.metagraph.sh/api/v1/self-health";
const NATIVE_DATE = "Sun, 18 Oct 2026 19:59:31 GMT";
const NATIVE_EXPIRES = "Sun, 18 Oct 2026 23:59:31 GMT";
const globals = globalThis as unknown as { caches?: unknown };
let originalCaches: unknown;
let stored: Response | undefined;
let puts: number;
let keys: string[];
let waits: Promise<unknown>[];

beforeEach(() => {
  originalCaches = globals.caches;
  stored = undefined;
  puts = 0;
  keys = [];
  waits = [];
  globals.caches = {
    default: {
      async match(request: Request) {
        keys.push(request.url);
        if (!stored) return undefined;
        const headers = new Headers(stored.headers);
        headers.set("cache-control", "public, max-age=14400");
        headers.set("expires", NATIVE_EXPIRES);
        headers.set("age", "8");
        headers.set("date", NATIVE_DATE);
        return new Response(stored.clone().body, { headers });
      },
      async put(_request: Request, response: Response) {
        puts += 1;
        // Native storage refuses no-store responses; a fake must not turn one
        // into a hit that production cannot produce.
        if (response.headers.get("cache-control") !== "no-store")
          stored = response.clone();
      },
    },
  };
});

afterEach(() => {
  globals.caches = originalCaches;
});

async function deliver(
  request: Request,
  build: (request: Request) => Response | Promise<Response>,
) {
  const response = await withStampedEdgeCache(
    request,
    { waitUntil: (pending) => waits.push(pending) },
    {} as Env,
    "self-health",
    build,
    null,
    async () => "unchanged-health-stamp",
  );
  await Promise.all(waits.splice(0));
  return response;
}

function assertPrivateMetadataAbsent(response: Response) {
  assert.equal(response.headers.has(CONTROL), false);
  assert.equal(response.headers.has(EXPIRES), false);
}

test.each(["GET", "HEAD", "conditional GET"])(
  "a rewritten %s hit preserves the exact source policy and response identity",
  async (method) => {
    const build = vi.fn((request: Request) =>
      envelopeResponse(
        request,
        { data: { stale_lane_count: 31 }, meta: {} },
        "short",
      ),
    );
    const first = await deliver(new Request(TARGET), build);
    const body = await first.text();
    const etag = first.headers.get("etag")!;
    const policy = first.headers.get("cache-control");
    assert.equal(policy, "public, max-age=60, stale-while-revalidate=300");
    assert.equal(first.headers.get("x-metagraph-cache"), "miss");
    assertPrivateMetadataAbsent(first);
    assert.equal(stored!.headers.get(CONTROL), `+${policy}`);
    assert.equal(stored!.headers.get(EXPIRES), "-");
    const response = await deliver(
      new Request(TARGET, {
        method: method === "HEAD" ? "HEAD" : "GET",
        headers: method === "conditional GET" ? { "if-none-match": etag } : {},
      }),
      build,
    );
    assert.equal(response.status, method === "conditional GET" ? 304 : 200);
    assert.equal(await response.text(), method === "GET" ? body : "");
    assert.equal(response.headers.get("cache-control"), policy);
    assert.equal(response.headers.get("expires"), null);
    assert.equal(response.headers.get("etag"), etag);
    assert.equal(response.headers.get("age"), "8");
    assert.equal(response.headers.get("date"), NATIVE_DATE);
    assert.equal(response.headers.get("x-metagraph-cache-profile"), "short");
    assert.equal(response.headers.get("x-metagraph-cache"), "hit");
    assertPrivateMetadataAbsent(response);
    assert.equal(build.mock.calls.length, 1);
    assert.equal(puts, 1);
    assert.equal(
      keys[0],
      keys[1],
      "method and validators keep the same cache key",
    );
  },
);

test.each([
  ["public, max-age=17, stale-if-error=11", "Sun, 18 Oct 2026 20:00:00 GMT"],
  [null, "Sun, 18 Oct 2026 20:00:00 GMT"],
  [null, null],
  ["", ""],
] as const)(
  "cache hits preserve original Cache-Control %j and Expires %j",
  async (control, expires) => {
    const build = vi.fn((_request: Request) => {
      const headers = new Headers({ "x-metagraph-cache-profile": "short" });
      if (control !== null) headers.set("cache-control", control);
      if (expires !== null) headers.set("expires", expires);
      return new Response("current observations", { headers });
    });
    const request = () =>
      new Request(TARGET, {
        headers: { [CONTROL]: "+public, max-age=999999", [EXPIRES]: "-" },
      });
    const first = await deliver(request(), build);
    const hit = await deliver(request(), build);
    for (const response of [first, hit]) {
      assert.equal(response.headers.get("cache-control"), control);
      assert.equal(response.headers.get("expires"), expires);
      assert.equal(await response.text(), "current observations");
      assertPrivateMetadataAbsent(response);
    }
    assert.equal(hit.headers.get("x-metagraph-cache"), "hit");
    assert.equal(build.mock.calls.length, 1);
  },
);

const unqualifiedPolicies: Record<string, string>[] = [
  {},
  { [CONTROL]: "+public, max-age=60" },
  { [EXPIRES]: "-" },
  { [CONTROL]: "invalid", [EXPIRES]: "-" },
  { [CONTROL]: "+public, max-age=60", [EXPIRES]: "invalid" },
];
test.each(unqualifiedPolicies)(
  "an unqualified cached policy %j is rebuilt",
  async (metadata) => {
    stored = new Response("legacy observations", {
      headers: {
        "cache-control": "public, max-age=14400",
        "x-metagraph-cache-profile": "short",
        ...metadata,
      },
    });
    const build = vi.fn((_request: Request) =>
      new Response("current observations", {
        headers: { "cache-control": "public, max-age=17" },
      }),
    );
    const first = await deliver(new Request(TARGET), build);
    assert.equal(first.headers.get("x-metagraph-cache"), "miss");
    assert.equal(first.headers.get("cache-control"), "public, max-age=17");
    assert.equal(await first.text(), "current observations");
    assertPrivateMetadataAbsent(first);
    const hit = await deliver(new Request(TARGET), build);
    assert.equal(hit.headers.get("x-metagraph-cache"), "hit");
    assert.equal(hit.headers.get("cache-control"), "public, max-age=17");
    assert.equal(await hit.text(), "current observations");
    assertPrivateMetadataAbsent(hit);
    assert.equal(build.mock.calls.length, 1);
  },
);

test("a no-store source remains no-store and never produces a hit", async () => {
  const build = vi.fn(async (request: Request) =>
    withNoStore(
      await envelopeResponse(request, { data: {}, meta: {} }, "short"),
    ),
  );
  for (let tick = 0; tick < 2; tick++) {
    const response = await deliver(new Request(TARGET), build);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-metagraph-cache-profile"), "no-store");
    assert.equal(response.headers.get("x-metagraph-cache"), "miss");
    assertPrivateMetadataAbsent(response);
  }
  assert.equal(build.mock.calls.length, 2);
  assert.equal(stored, undefined);
});

test("a legacy zero-argument HEAD builder keeps its uncached delivery", async () => {
  const build = vi.fn(() =>
    envelopeResponse(
      new Request(TARGET, { method: "HEAD" }),
      { data: {}, meta: {} },
      "short",
    ),
  );
  const response = await deliver(
    new Request(TARGET, { method: "HEAD" }),
    build,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(response.headers.get("x-metagraph-cache"), "miss");
  assertPrivateMetadataAbsent(response);
  assert.equal(keys.length, 0);
  assert.equal(puts, 0);
});

test("an unqualified conditional hit revalidates through the handler", async () => {
  const build = vi.fn((request: Request) =>
    envelopeResponse(request, { data: {}, meta: {} }, "short"),
  );
  const source = await build(new Request(TARGET));
  const etag = source.headers.get("etag")!;
  stored = source;
  const response = await deliver(
    new Request(TARGET, { headers: { "if-none-match": etag } }),
    build,
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(response.headers.get("x-metagraph-cache"), "miss");
  assertPrivateMetadataAbsent(response);
  assert.equal(
    puts,
    0,
    "a revalidated 304 must not seed a bodyless cache entry",
  );
  assert.equal(build.mock.calls.length, 2);
});

test.each([undefined, {}])(
  "a missing cache writer %j does not clone an unused response stream",
  async (context) => {
    const built = new Response("current observations");
    const clone = vi.spyOn(built, "clone");
    const response = await withStampedEdgeCache(
      new Request(TARGET),
      context,
      {} as Env,
      "self-health",
      () => built,
      null,
      async () => "unchanged-health-stamp",
    );
    assert.equal(clone.mock.calls.length, 0);
    assert.equal(puts, 0);
    assert.equal(await response.text(), "current observations");
    assertPrivateMetadataAbsent(response);
  },
);
