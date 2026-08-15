// #10548: whether a registered origin is still there.
//
// The fixtures are REAL observations, taken by running this classifier over all
// 277 origins in the registry on 2026-08-11. That matters more than usual here,
// because the thing under test decides whether we tell the world a subnet's API
// host is gone — and the two dead-host shapes it found are ones no vendor-string
// matcher would have caught together:
//
//   - Railway's placeholder, byte-identical across every path (and byte-identical
//     between SN37 Aurelius and SN58 Handshake58 — two different subnets, one
//     dead platform);
//   - SN4 Targon's `410 Gone` with an EMPTY body, which is the server explicitly
//     saying the resource is permanently gone.
//
// One rule catches both: a real API says different things about different paths.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { SEND_BATCH_MAX } from "../src/lane-queue.ts";
import worker, {
  handleScheduled,
  probeOrigin,
  registeredSurfaces,
} from "../workers/api.ts";
import { LANE_HEARTBEAT_CRON } from "../workers/config.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
import {
  ORIGIN_SAMPLE_SIZE,
  enqueueOriginChecks,
  handleOriginBatch,
  type OriginMessage,
  loadDeadOrigins,
  persistOriginCheck,
  checkOrigin,
  classifyOrigin,
  normaliseBody,
  sampleUrls,
  surfacesByOrigin,
  type OriginSample,
} from "../src/origin-reachability.ts";

/** The Railway placeholder, as observed. */
const PLACEHOLDER = "0683635521b9";
/** sha256 of the empty string — Targon's 410 bodies. */
const EMPTY = "e3b0c44298";

const sample = (
  status: number | null,
  body_hash: string | null,
  url = "https://a.example/x",
): OriginSample => ({ url, status, body_hash });

/** One lane's entry in the heartbeat's aggregate result. The heartbeat runs
 * every producer, so a per-lane assertion has to look its own up. */
function laneResult(result: unknown) {
  const lanes = (result as { lanes?: Array<Record<string, unknown>> }).lanes;
  const found = (lanes ?? []).find((l) => l.lane === "origin-reachability");
  assert.ok(found, "origin-reachability must be in LANE_PRODUCERS");
  return found as { ok: boolean; enqueued: number; reason?: string };
}

describe("classifying an origin", () => {
  test("a dead platform host answering one placeholder for everything", () => {
    // SN37 Aurelius, verbatim: three registered paths, all 404, all the same
    // body. Sixty surfaces are registered on that origin and fifty of them were
    // probe-disabled, so nothing had ever checked them.
    assert.equal(
      classifyOrigin([
        sample(404, PLACEHOLDER, "https://x/docs"),
        sample(404, PLACEHOLDER, "https://x/openapi.json"),
        sample(404, PLACEHOLDER, "https://x/health"),
      ]),
      "not-routing",
    );
  });

  test("a `410 Gone` with an empty body is caught by the SAME rule", () => {
    // SN4 Targon. No vendor string to match here at all -- the bodies are
    // empty. What identifies it is that all three are identical, which is the
    // rule rather than a special case.
    assert.equal(
      classifyOrigin([
        sample(410, EMPTY, "https://x/tha/v2/inventory"),
        sample(410, EMPTY, "https://x/tha/v2/version"),
        sample(410, EMPTY, "https://x/tha/v2/healthz"),
      ]),
      "not-routing",
    );
  });

  test("a real API that 404s ONE path is serving", () => {
    // The false positive this must never produce: a healthy host where one
    // registered path has moved.
    assert.equal(
      classifyOrigin([
        sample(200, "aaa"),
        sample(404, "bbb"),
        sample(200, "ccc"),
      ]),
      "serving",
    );
  });

  test("errors with DIFFERENT bodies are a serving host, not a dead one", () => {
    // Two 404s that say different things are two real routes answering. Only
    // one body for all of them is a placeholder.
    assert.equal(
      classifyOrigin([sample(404, "aaa"), sample(404, "bbb")]),
      "serving",
    );
  });

  test("a single 401 is SERVING — an auth gate is a healthy signal", () => {
    // The bias, stated: one observation cannot tell a placeholder from an
    // auth-gated endpoint working exactly as designed. Declaring a live
    // subnet's API gone is not recoverable; under-reporting a dead one is.
    assert.equal(classifyOrigin([sample(401, "aaa")]), "serving");
    assert.equal(classifyOrigin([sample(404, PLACEHOLDER)]), "serving");
  });

  test("transport failure on every sample is `unreachable`", () => {
    // DNS, TCP or TLS. Distinct from not-routing: nothing answered at all.
    assert.equal(
      classifyOrigin([sample(null, null), sample(null, null)]),
      "unreachable",
    );
  });

  test("one live sample beside failures is still serving", () => {
    assert.equal(
      classifyOrigin([sample(null, null), sample(200, "aaa")]),
      "serving",
    );
  });

  test("no samples is `indeterminate`, never a finding", () => {
    assert.equal(classifyOrigin([]), "indeterminate");
  });

  test("a null body hash never counts toward the identical-body signal", () => {
    // Two responses we could not read are not two copies of one placeholder.
    assert.equal(
      classifyOrigin([sample(404, null), sample(404, null)]),
      "serving",
    );
  });
});

describe("normalising the body before hashing", () => {
  test("strips the per-request id a placeholder echoes", () => {
    // Railway's placeholder carries a unique request_id. Without this the
    // identical-body signal would never fire and this whole check would be
    // silently useless -- passing, and finding nothing, forever.
    const a = normaliseBody(
      '{"message":"Application not found","request_id":"aaa"}',
    );
    const b = normaliseBody(
      '{"message":"Application not found","request_id":"bbb"}',
    );
    assert.equal(a, b);
  });

  test("covers the spellings other platforms use", () => {
    for (const key of ["requestId", "trace_id", "traceId", "correlation_id"]) {
      const a = normaliseBody(`{"${key}":"1","x":"same"}`);
      const b = normaliseBody(`{"${key}":"2","x":"same"}`);
      assert.equal(a, b, key);
    }
  });

  test("does NOT flatten genuinely different bodies", () => {
    // The direction that produces a false accusation. Stripping more than
    // per-request ids would start making real responses look identical.
    assert.notEqual(
      normaliseBody('{"status":"ok","uptime":1}'),
      normaliseBody('{"status":"ok","uptime":2}'),
    );
  });
});

describe("grouping by origin", () => {
  test("keys on the origin, so one host is checked once for every subnet", () => {
    const byOrigin = surfacesByOrigin([
      { id: "a", url: "https://x.example/one" },
      { id: "b", url: "https://x.example/two" },
      { id: "c", url: "https://y.example/one" },
    ]);
    assert.deepEqual([...byOrigin.keys()].sort(), [
      "https://x.example",
      "https://y.example",
    ]);
    assert.equal(byOrigin.get("https://x.example")?.length, 2);
  });

  test("treats a different port as a different origin", () => {
    const byOrigin = surfacesByOrigin([
      { id: "a", url: "https://x.example:8443/one" },
      { id: "b", url: "https://x.example/one" },
    ]);
    assert.equal(byOrigin.size, 2);
  });

  test("skips a non-http scheme and an unparseable url", () => {
    assert.equal(
      surfacesByOrigin([
        { id: "a", url: "wss://x.example/ws" },
        { id: "b", url: "not a url" },
        { id: "c", url: "" },
        { id: "d" } as never,
      ]).size,
      0,
    );
  });
});

describe("choosing which paths to sample", () => {
  test("samples DISTINCT paths, so one url cannot manufacture the signal", () => {
    // Two samples of the same url return two identical bodies, which would
    // read as a placeholder when it is one route answering twice.
    assert.deepEqual(
      sampleUrls([
        { id: "a", url: "https://x.example/one" },
        { id: "b", url: "https://x.example/one" },
        { id: "c", url: "https://x.example/two" },
      ]),
      ["https://x.example/one", "https://x.example/two"],
    );
  });

  test("caps the samples per origin", () => {
    const many = Array.from({ length: ORIGIN_SAMPLE_SIZE + 4 }, (_, i) => ({
      id: `s${i}`,
      url: `https://x.example/${i}`,
    }));
    assert.equal(sampleUrls(many).length, ORIGIN_SAMPLE_SIZE);
  });

  test("uses REGISTERED paths, never an invented one", () => {
    // A synthetic path would 404 legitimately on a healthy API and answer a
    // different question from the one being asked.
    assert.deepEqual(
      sampleUrls([{ id: "a", url: "https://x.example/health" }]),
      ["https://x.example/health"],
    );
  });

  test("an unparseable url is skipped rather than sampled", () => {
    assert.deepEqual(sampleUrls([{ id: "a", url: "not a url" }]), []);
  });
});

describe("checking one origin", () => {
  test("records every sample and names every surface the verdict covers", async () => {
    // The verdict is about the HOST, so it has to carry the surfaces it
    // condemns -- including the probe-disabled ones no prober may touch, which
    // is the entire reason this exists.
    const out = await checkOrigin(
      "https://x.example",
      [
        { id: "s1", url: "https://x.example/a" },
        { id: "s2", url: "https://x.example/b" },
        { id: "s3-probe-disabled", url: "https://x.example/c" },
      ],
      {
        probe: async () => ({ status: 404, bodyHash: PLACEHOLDER }),
        now: () => 1_786_320_000_000,
      },
    );
    assert.equal(out.verdict, "not-routing");
    assert.equal(out.samples.length, 3);
    assert.deepEqual(out.surface_ids, ["s1", "s2", "s3-probe-disabled"]);
    assert.equal(out.checked_at, 1_786_320_000_000);
  });

  test("a thrown probe is recorded as a failed sample, not dropped", async () => {
    // Dropping it would shrink the set the verdict is drawn from without
    // saying so, and could turn an unreachable host into a `serving` one.
    const out = await checkOrigin(
      "https://x.example",
      [
        { id: "a", url: "https://x.example/a" },
        { id: "b", url: "https://x.example/b" },
      ],
      {
        probe: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    assert.equal(out.samples.length, 2);
    assert.equal(out.verdict, "unreachable");
  });

  test("defaults to the wall clock", async () => {
    const before = Date.now();
    const out = await checkOrigin("https://x.example", [], {
      probe: async () => ({ status: 200, bodyHash: "a" }),
    });
    assert.ok(out.checked_at >= before);
    assert.equal(out.verdict, "indeterminate");
  });
});

describe("the store", () => {
  function db(sink: { sql: string; binds: unknown[] }[], rows: unknown[] = []) {
    return {
      async run(sql: string, binds: unknown[] = []) {
        sink.push({ sql, binds });
        return { changes: 1 };
      },
      async query<T>(sql: string, binds: unknown[] = []) {
        sink.push({ sql, binds });
        return rows as T[];
      },
    };
  }

  const check = {
    origin: "https://x.example",
    checked_at: 1_786_320_000_000,
    samples: [sample(404, PLACEHOLDER)],
    verdict: "not-routing" as const,
    surface_ids: ["a", "b", "c"],
  };

  test("upserts, and carries how many surfaces the verdict covers", async () => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    assert.deepEqual(await persistOriginCheck(db(calls), check), { ok: true });
    assert.match(calls[0].sql, /ON CONFLICT \(origin\) DO UPDATE/);
    assert.doesNotMatch(calls[0].sql, /INSERT OR REPLACE/);
    assert.deepEqual(calls[0].binds, [
      "https://x.example",
      1_786_320_000_000,
      3,
      1,
      "not-routing",
    ]);
  });

  test("no binding is a stated refusal, not a silent success", async () => {
    assert.deepEqual(await persistOriginCheck(null, check), {
      ok: false,
      reason: "no_store_binding",
    });
  });

  test("a write failure is reported rather than swallowed", async () => {
    const out = await persistOriginCheck(
      {
        run() {
          throw new Error("relation does not exist");
        },
      },
      check,
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /relation does not exist/);
  });

  test("reads back only the adverse verdicts", async () => {
    const out = await loadDeadOrigins(
      db(
        [],
        [
          {
            origin: "https://x.example",
            checked_at: 1_786_320_000_000,
            surface_count: 60,
            samples: 3,
            verdict: "not-routing",
          },
        ],
      ),
    );
    assert.equal(out?.length, 1);
    assert.equal(out?.[0].checked_at, "2026-08-10T00:00:00.000Z");
    assert.equal(out?.[0].surface_count, 60);
  });

  test("a failed read is NULL, never an empty list", async () => {
    // "Nothing is dead" and "we could not check" are different claims, and only
    // one of them is reassuring.
    assert.equal(await loadDeadOrigins(null), null);
    assert.equal(
      await loadDeadOrigins({
        query() {
          throw new Error("store unavailable");
        },
      }),
      null,
    );
  });

  test("a corrupt timestamp nulls the date rather than inventing 1970", async () => {
    const out = await loadDeadOrigins(
      db(
        [],
        [{ origin: "https://x", checked_at: "nope", verdict: "unreachable" }],
      ),
    );
    assert.equal(out?.[0].checked_at, null);
    assert.equal(out?.[0].surface_count, 0);
  });
});

describe("the wiring — a correct lane nobody calls is the defect", () => {
  test("the cron is registered as a trigger and collides with nothing", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.ok(
      wrangler.includes(`"${LANE_HEARTBEAT_CRON}"`),
      `${LANE_HEARTBEAT_CRON} is not in wrangler.jsonc triggers.crons`,
    );
    assert.equal(LANE_HEARTBEAT_CRON, "26 * * * *");
  });

  test("dispatch and its label both know the cron", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /if \(cron === LANE_HEARTBEAT_CRON\) \{/);
    assert.match(api, /return "lane-heartbeat"/);
  });

  test("handleScheduled routes the cron to the PRODUCER, and it declines cleanly", async () => {
    // The cron no longer checks -- it enqueues. The BINDING is reported before
    // the empty list, and that order is the useful one: a missing binding is a
    // config error, and saying "no origins" would send someone to the registry.
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        {} as unknown as Parameters<typeof handleScheduled>[1],
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.enqueued, 0);
    assert.equal(result.reason, "no_queue_binding");
  });

  // This test's flag-declared premise retired with NEON_SOLE_STORE_TABLES
  // (#10051): Neon is the only store, so an undeclared/partial state cannot
  // exist. "A reader names a table no migration creates" is owned by
  // tests/neon-sole-store-tables-exist.test.ts, derived from the code.

  test("the migration stores every verdict the code can emit", async () => {
    const sql = await fs.readFile(
      path.join(repoRoot, "migrations/neon/0019_origin_reachability.sql"),
      "utf8",
    );
    for (const verdict of [
      "serving",
      "unreachable",
      "not-routing",
      "indeterminate",
    ]) {
      assert.ok(sql.includes(`'${verdict}'`), `${verdict} is not storable`);
    }
  });
});

describe("the worker's two halves", () => {
  function artifactEnv(payload: unknown) {
    const target = "/metagraph/surfaces.json";
    const hit = (p: string) => p === target && payload != null;
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return hit(pathname)
            ? Response.json(payload as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          return hit(p)
            ? {
                async json() {
                  return payload;
                },
              }
            : null;
        },
      },
    };
  }

  test("reads EVERY registered surface, including probe-disabled ones", async () => {
    // The entire point: a probe-disabled surface is invisible to the prober,
    // and must not be invisible here too.
    const out = await registeredSurfaces(
      artifactEnv({
        surfaces: [
          { id: "a", url: "https://x.example/a", probe: { enabled: true } },
          { id: "b", url: "https://x.example/b", probe: { enabled: false } },
          { id: "no-url" },
          null,
        ],
      }) as never,
    );
    assert.deepEqual(
      out.map((s) => s.id),
      ["a", "b"],
    );
  });

  test("no artifact is an empty list, never a throw", async () => {
    assert.deepEqual(await registeredSurfaces(artifactEnv(null) as never), []);
    assert.deepEqual(
      await registeredSurfaces(artifactEnv({ surfaces: "nope" }) as never),
      [],
    );
  });

  test("a sample hashes the NORMALISED body, and any failure is a null status", async () => {
    const original = globalThis.fetch;
    try {
      // Two responses differing only in their request id must hash the same,
      // or the identical-placeholder signal never fires.
      globalThis.fetch = (async () =>
        new Response('{"m":"gone","request_id":"aaa"}', {
          status: 404,
        })) as typeof fetch;
      const a = await probeOrigin("https://x.example/a");
      globalThis.fetch = (async () =>
        new Response('{"m":"gone","request_id":"zzz"}', {
          status: 404,
        })) as typeof fetch;
      const b = await probeOrigin("https://x.example/b");
      assert.equal(a.status, 404);
      assert.equal(a.bodyHash, b.bodyHash);

      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;
      assert.deepEqual(await probeOrigin("https://x.example/a"), {
        status: null,
        bodyHash: null,
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("shapes the store can really produce", () => {
  test("a thrown non-Error still names the failure", async () => {
    const out = await persistOriginCheck(
      {
        run() {
          throw "a bare string";
        },
      },
      {
        origin: "https://x",
        checked_at: 1_786_320_000_000,
        samples: [],
        verdict: "indeterminate",
        surface_ids: [],
      },
    );
    assert.match(String(out.reason), /a bare string/);
  });

  // "a driver returning no results key" retired with D1's envelope
  // (#10309): query() answers rows directly, so there is no envelope whose
  // absence needs a reading. The nothing-dead case is the empty array.

  test("a row with no origin or verdict still reads without inventing one", async () => {
    const db = {
      query: async <T>() => [{}] as T[],
    };
    const out = await loadDeadOrigins(db);
    assert.equal(out?.[0].origin, "");
    assert.equal(out?.[0].verdict, null);
  });

  test("a 2xx among errors keeps the origin serving", () => {
    assert.equal(
      classifyOrigin([sample(200, "a"), sample(404, "a")]),
      "serving",
    );
  });
});

describe("the queue lane", () => {
  function queue(sent: Array<Array<{ body: unknown }>>, fail = false) {
    return {
      async sendBatch(messages: Array<{ body: OriginMessage }>) {
        if (fail) throw new Error("queue unavailable");
        sent.push(messages);
      },
    };
  }

  test("enqueues EVERY origin, not a slice", async () => {
    const sent: Array<Array<{ body: unknown }>> = [];
    const out = await enqueueOriginChecks(queue(sent), [
      "https://a",
      "https://b",
    ]);
    assert.deepEqual(out, { ok: true, enqueued: 2 });
  });

  test("splits at the sendBatch cap", async () => {
    // 277 origins is three batches at Cloudflare's 100-message cap.
    const sent: Array<Array<{ body: unknown }>> = [];
    const many = Array.from(
      { length: SEND_BATCH_MAX + 7 },
      (_, i) => `https://h${i}`,
    );
    await enqueueOriginChecks(queue(sent), many);
    assert.deepEqual(
      sent.map((b) => b.length),
      [SEND_BATCH_MAX, 7],
    );
  });

  test("no binding and an empty list are both stated refusals", async () => {
    assert.equal(
      (await enqueueOriginChecks(null, ["https://a"])).reason,
      "no_queue_binding",
    );
    assert.equal(
      (await enqueueOriginChecks(queue([]), [])).reason,
      "no_origins_to_check",
    );
  });

  test("a send failure reports what actually went out", async () => {
    const out = await enqueueOriginChecks(queue([], true), ["https://a"]);
    assert.equal(out.ok, false);
    assert.equal(out.enqueued, 0);
    assert.match(String(out.reason), /queue unavailable/);
  });

  test("a thrown non-Error still names the failure", async () => {
    const out = await enqueueOriginChecks(
      {
        async sendBatch() {
          throw "a bare string";
        },
      },
      ["https://a"],
    );
    assert.match(String(out.reason), /a bare string/);
  });
});

describe("consuming an origin batch", () => {
  function message(body: unknown) {
    const calls = { acked: 0, retried: 0 };
    return {
      body,
      ack: () => void (calls.acked += 1),
      retry: () => void (calls.retried += 1),
      calls,
    };
  }

  const store = () => ({
    run: async () => ({ changes: 1 }),
    query: async <T>() => [] as T[],
  });

  const deps = (over: Record<string, unknown> = {}) => ({
    probe: async () => ({ status: 200, bodyHash: "a" }),
    now: () => 1_786_320_000_000,
    surfacesFor: async () => [{ id: "s1", url: "https://x.example/a" }],
    ...over,
  });

  test("acks a checked origin", async () => {
    const m = message({ origin: "https://x.example" });
    const out = await handleOriginBatch([m], store(), deps() as never);
    assert.deepEqual(out, { done: 1, retried: 0, dropped: 0 });
    assert.equal(m.calls.acked, 1);
  });

  test("resolves the surfaces at DELIVERY, not from the message", async () => {
    // A message that waited must not check a stale copy of what the registry
    // advertises.
    let askedFor: string | null = null;
    await handleOriginBatch(
      [message({ origin: "https://y.example" })],
      store(),
      deps({
        surfacesFor: async (origin: string) => {
          askedFor = origin;
          return [];
        },
      }) as never,
    );
    assert.equal(askedFor, "https://y.example");
  });

  test("RETRIES when the check succeeded but the WRITE failed", async () => {
    const m = message({ origin: "https://x.example" });
    const out = await handleOriginBatch([m], null, deps() as never);
    assert.deepEqual(out, { done: 0, retried: 1, dropped: 0 });
  });

  test("RETRIES when resolving the surfaces throws", async () => {
    const m = message({ origin: "https://x.example" });
    const out = await handleOriginBatch(
      [m],
      store(),
      deps({
        surfacesFor: async () => {
          throw new Error("artifact read exploded");
        },
      }) as never,
    );
    assert.equal(out.retried, 1);
    assert.equal(m.calls.retried, 1);
  });

  test("ACKS a malformed message rather than looping it to the dead letter", async () => {
    const bad = [message({ origin: 42 }), message({}), message(null)];
    const out = await handleOriginBatch(bad, store(), deps() as never);
    assert.deepEqual(out, { done: 0, retried: 0, dropped: 3 });
    for (const m of bad) assert.equal(m.calls.acked, 1);
  });

  test("one bad message does not stop the rest of the batch", async () => {
    const good = message({ origin: "https://x.example" });
    const out = await handleOriginBatch(
      [message(null), good],
      store(),
      deps() as never,
    );
    assert.equal(out.done, 1);
    assert.equal(out.dropped, 1);
  });
});

describe("the origin queue wiring", () => {
  test("the dead-letter queue is registered as a lane", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "src/dead-letter.ts"),
      "utf8",
    );
    assert.match(source, /"probe-jobs-dlq"/);
  });

  test("both queues are declared, with a dead letter", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.match(wrangler, /"binding": "PROBE_JOBS"/);
    assert.match(wrangler, /"queue": "probe-jobs"/);
    assert.match(wrangler, /"dead_letter_queue": "probe-jobs-dlq"/);
  });

  test("the consumer branches on the queue name", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /"origin-reachability": run[A-Za-z]+Jobs,/);
  });
});

describe("the origin queue, through the Worker's own handler", () => {
  const SURFACES = "/metagraph/surfaces.json";

  function env(payload: unknown, extra: Record<string, unknown> = {}) {
    const hit = (p: string) => p === SURFACES && payload != null;
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return hit(pathname)
            ? Response.json(payload as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          return hit(p)
            ? {
                async json() {
                  return payload;
                },
              }
            : null;
        },
      },
      ...extra,
    };
  }

  const registry = {
    surfaces: [
      { id: "a", url: "https://x.example/one" },
      { id: "b", url: "https://x.example/two" },
    ],
  };

  test("the cron producer enqueues every registered ORIGIN, deduplicated", async () => {
    // Two surfaces on one host is one message, not two -- that is the whole
    // saving over a per-surface pass.
    const sent: string[] = [];
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        env(registry, {
          PROBE_JOBS: {
            async sendBatch(messages: Array<{ body: { origin: string } }>) {
              for (const m of messages) sent.push(m.body.origin);
            },
          },
        }) as never,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.deepEqual(result, {
      lane: "origin-reachability",
      ok: true,
      enqueued: 1,
    });
    assert.deepEqual(sent, ["https://x.example"]);
  });

  test("an origin batch is routed to the origin consumer, not the webhook path", async () => {
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: {
            job_type: "origin-reachability",
            origin: "https://x.example",
          },
          ack: () => {},
          retry: () => {},
        },
      ],
    };
    await assert.doesNotReject(() =>
      worker.queue!(
        batch as never,
        env(registry) as never,
        { waitUntil: () => {} } as never,
      ),
    );
  });

  test("an origin with no registered surfaces resolves to an empty list", async () => {
    // A message for an origin the registry no longer advertises: the lookup
    // misses, and the check runs against nothing rather than throwing.
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: { origin: "https://gone.example" },
          ack: () => {},
          retry: () => {},
        },
      ],
    };
    await assert.doesNotReject(() =>
      worker.queue!(
        batch as never,
        env(registry) as never,
        { waitUntil: () => {} } as never,
      ),
    );
  });

  test("a malformed origin message is acked at the Worker level too", async () => {
    let acked = 0;
    const batch = {
      queue: "probe-jobs",
      messages: [
        { body: { origin: 42 }, ack: () => void (acked += 1), retry: () => {} },
      ],
    };
    await worker.queue!(
      batch as never,
      env(registry) as never,
      { waitUntil: () => {} } as never,
    );
    assert.equal(acked, 1);
  });
});
