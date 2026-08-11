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
import { handleScheduled } from "../workers/api.ts";
import { ORIGIN_REACHABILITY_CRON } from "../workers/config.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
import {
  ORIGIN_BATCH_SIZE,
  ORIGIN_SAMPLE_SIZE,
  loadDeadOrigins,
  loadOriginCheckedAt,
  persistOriginCheck,
  runOriginReachabilityTick,
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
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            sink.push({ sql, binds });
            return {
              run: async () => undefined,
              all: async () => ({ results: rows }),
            };
          },
          all: async () => ({ results: rows }),
        };
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
        prepare() {
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
        prepare() {
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

  test("reads every origin's last check for the staleness ordering", async () => {
    const map = await loadOriginCheckedAt(
      db(
        [],
        [
          { origin: "https://a", checked_at: 5 },
          { origin: "https://b", checked_at: "nope" },
        ],
      ),
    );
    assert.deepEqual([...map.entries()], [["https://a", 5]]);
    assert.equal((await loadOriginCheckedAt(null)).size, 0);
    assert.equal(
      (
        await loadOriginCheckedAt({
          prepare() {
            throw new Error("down");
          },
        })
      ).size,
      0,
    );
  });
});

describe("the lane", () => {
  const store = () => ({
    prepare: () => ({
      bind: () => ({
        run: async () => undefined,
        all: async () => ({ results: [] }),
      }),
      all: async () => ({ results: [] }),
    }),
  });

  const surfaces = [
    { id: "dead-1", url: "https://dead.example/a" },
    { id: "dead-2", url: "https://dead.example/b" },
    { id: "live-1", url: "https://live.example/a" },
    { id: "live-2", url: "https://live.example/b" },
  ];

  test("counts the verdicts and the SURFACES an adverse one covers", async () => {
    // The number that makes the finding actionable. 128 across 11 origins, the
    // first time this ran against the real registry.
    const out = await runOriginReachabilityTick(store(), surfaces, {
      probe: async (url) =>
        url.startsWith("https://dead.example")
          ? { status: 404, bodyHash: PLACEHOLDER }
          : { status: 200, bodyHash: url },
    });
    assert.equal(out.checked, 2);
    assert.equal(out.verdicts["not-routing"], 1);
    assert.equal(out.verdicts.serving, 1);
    assert.equal(out.surfaces_affected, 2, "both surfaces on the dead origin");
    assert.equal(out.ok, true);
  });

  test("checks the LEAST RECENTLY checked first, never-checked before that", async () => {
    const checked: string[] = [];
    await runOriginReachabilityTick(store(), surfaces, {
      probe: async (url) => {
        checked.push(new URL(url).origin);
        return { status: 200, bodyHash: url };
      },
      batch: 1,
      checkedAt: new Map([["https://dead.example", 5_000]]),
    });
    // live.example has never been checked: the only state where we have said
    // nothing at all about it.
    assert.deepEqual([...new Set(checked)], ["https://live.example"]);
  });

  test("an EMPTY batch is not a success", async () => {
    const out = await runOriginReachabilityTick(store(), [], {
      probe: async () => ({ status: 200, bodyHash: "a" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no_origins_to_check");
  });

  test("a write failure fails the tick rather than being swallowed", async () => {
    const out = await runOriginReachabilityTick(null, surfaces, {
      probe: async () => ({ status: 200, bodyHash: "a" }),
    });
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /no_store_binding/);
    assert.equal(out.checked, 2, "it still checked -- only the write failed");
  });

  test("the batch defaults to the declared size", async () => {
    const many = Array.from({ length: ORIGIN_BATCH_SIZE + 5 }, (_, i) => ({
      id: `s${i}`,
      url: `https://h${i}.example/a`,
    }));
    const out = await runOriginReachabilityTick(store(), many, {
      probe: async () => ({ status: 200, bodyHash: "a" }),
    });
    assert.equal(out.checked, ORIGIN_BATCH_SIZE);
  });
});

describe("the wiring — a correct lane nobody calls is the defect", () => {
  test("the cron is registered as a trigger and collides with nothing", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.ok(
      wrangler.includes(`"${ORIGIN_REACHABILITY_CRON}"`),
      `${ORIGIN_REACHABILITY_CRON} is not in wrangler.jsonc triggers.crons`,
    );
    assert.equal(ORIGIN_REACHABILITY_CRON, "9,39 * * * *");
  });

  test("dispatch and its label both know the cron", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /if \(cron === ORIGIN_REACHABILITY_CRON\) \{/);
    assert.match(api, /return "origin-reachability"/);
  });

  test("handleScheduled routes the cron to the lane", async () => {
    const result = (await handleScheduled(
      { cron: ORIGIN_REACHABILITY_CRON } as unknown as ScheduledController,
      {} as unknown as Parameters<typeof handleScheduled>[1],
      { waitUntil: () => {} } as unknown as ExecutionContext,
    )) as { ok: boolean; checked: number; reason?: string };
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.equal(result.reason, "no_origins_to_check");
  });

  test("the table is declared Neon sole-store in every config", async () => {
    for (const config of [
      "wrangler.jsonc",
      "wrangler.data.jsonc",
      "wrangler.registry.jsonc",
    ]) {
      const text = await fs.readFile(path.join(repoRoot, config), "utf8");
      assert.ok(
        text.includes("origin_reachability"),
        `origin_reachability is not declared sole-store in ${config}`,
      );
    }
  });

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
