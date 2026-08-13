// #11023. /api/v1/health cost 294-660 ms CPU per request in production, and the
// cost was its INPUT, not its output: loadGlobalOperationalHealth reads KV
// `health:current` -- a 253 KB value -- with `{ type: "json" }` and parses all
// of it to project a summary.
//
// The property under test is that the expensive read happens ONCE PER SNAPSHOT,
// not once per request. Asserting response equality would pass on the old
// behaviour too, so every case here counts reads of `health:current`.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { KV_HEALTH_CURRENT, KV_HEALTH_META } from "../src/kv-keys.ts";
import type { Row } from "./row-type.ts";

const globalWithCaches = globalThis as unknown as { caches?: unknown };
const originalCaches = globalWithCaches.caches;
afterEach(() => {
  globalWithCaches.caches = originalCaches;
});

function installCaches() {
  const store = new Map<string, Response>();
  globalWithCaches.caches = {
    default: {
      async match(request: Request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request: Request, response: Response) {
        store.set(request.url, response.clone());
      },
    },
  } as unknown as Row;
  return store;
}

/** An env whose KV counts reads of the expensive snapshot. */
function envWithHealth(lastRunAt: () => string) {
  const reads = { current: 0, meta: 0 };
  const env = {
    METAGRAPH_CONTROL: {
      get: async (key: string) => {
        if (key === KV_HEALTH_META) {
          reads.meta += 1;
          return { last_run_at: lastRunAt(), status_counts: {} };
        }
        if (key === KV_HEALTH_CURRENT) {
          reads.current += 1;
          return {
            generated_at: lastRunAt(),
            global: { status: "up" },
            subnets: {},
          };
        }
        return null;
      },
      put: async () => {},
    },
  } as unknown as Parameters<typeof handleRequest>[1];
  return { env, reads };
}

const get = (path: string) =>
  new Request(`https://api.metagraph.sh${path}`, {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

describe("health is cached on the snapshot's own stamp (#11023)", () => {
  test("a second request within one snapshot does NOT re-read the 253 KB value", async () => {
    installCaches();
    const { env, reads } = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    const first = await handleRequest(get("/api/v1/health"), env, ctx);
    assert.equal(first.status, 200);
    await Promise.all(waits);
    const afterFirst = reads.current;
    assert.ok(afterFirst > 0, "the first request must actually read it");

    const second = await handleRequest(get("/api/v1/health"), env, ctx);
    assert.equal(second.status, 200);
    // THE assertion. The cheap meta read still happens (it is the cache key);
    // the expensive one does not.
    assert.equal(reads.current, afterFirst);
  });

  test("a new snapshot invalidates it -- staleness is bounded by the cron", async () => {
    const store = installCaches();
    const first = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    await handleRequest(get("/api/v1/health"), first.env, ctx);
    await Promise.all(waits);
    assert.ok(first.reads.current > 0);

    // A SECOND env, deliberately. readHealthMetaKv memoizes the stamp for
    // HEALTH_META_KV_TTL_MS keyed on `env` IDENTITY, so reusing the same object
    // would keep serving the old stamp and this test would be asserting the
    // memo rather than the cache key. A different env is also what reality
    // looks like: the next request lands in another isolate with its own memo.
    const next = envWithHealth(() => "2026-08-13T07:02:00.000Z");
    await handleRequest(get("/api/v1/health"), next.env, ctx);
    // The prober writes KV_HEALTH_CURRENT and KV_HEALTH_META in one
    // Promise.all, so a moved stamp means a moved snapshot -- which is what
    // makes this a safe cache key rather than a guess.
    assert.ok(
      next.reads.current > 0,
      "a new snapshot must not be served from the previous stamp's entry",
    );
    // Two stamps, two entries -- the old one is not overwritten, it is simply
    // no longer addressed.
    assert.equal(store.size, 2);
  });

  test("the per-subnet route gets the same treatment", async () => {
    // Its OUTPUT is small, which is why the endpoints note excludes the small
    // per-subnet variant -- but its INPUT is the same 253 KB snapshot, so the
    // small-output argument does not apply to it.
    installCaches();
    const { env, reads } = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    await handleRequest(get("/api/v1/subnets/1/health"), env, ctx);
    await Promise.all(waits);
    const afterFirst = reads.current;

    await handleRequest(get("/api/v1/subnets/1/health"), env, ctx);
    assert.equal(reads.current, afterFirst);
  });
});
