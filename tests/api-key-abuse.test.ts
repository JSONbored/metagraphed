// #8611: per-key abuse controls.
//
// This is the code that can cut off a paying customer, so the properties under
// test are weighted accordingly: the blocklist FAILS OPEN on every malformed
// input (a false block has total blast radius, a false allow costs one TTL of
// traffic from a known bad actor), signals only ever RANK a queue rather than
// blocking anyone, and the internal note never reaches the blocked caller.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  BLOCK_REASON_CODES,
  ROUTE_SPREAD_MIN_ROUTES,
  SINGLE_ROUTE_MIN_REQUESTS,
  SUSTAINED_CEILING_MIN_DAYS,
  evaluateBlock,
  isBlockReasonCode,
  scoreUsageAnomalies,
  type UsageDay,
} from "../src/api-key-abuse.ts";

describe("block reason codes are a closed set", () => {
  test("accepts every published code and nothing else", () => {
    for (const code of Object.keys(BLOCK_REASON_CODES)) {
      assert.equal(isBlockReasonCode(code), true, code);
    }
    for (const bad of ["", "nope", "ABUSE_MANUAL", 1, null, undefined, {}]) {
      assert.equal(isBlockReasonCode(bad), false, String(bad));
    }
  });

  test("does not accept inherited Object members", () => {
    // `reason_code` arrives from an internal HTTP body. A naive `in` or truthy
    // index check would resolve these off the prototype chain and let an
    // unknown code through -- the bypass class fixed in #8687 and #8636.
    for (const hostile of [
      "constructor",
      "toString",
      "valueOf",
      "__proto__",
      "hasOwnProperty",
    ]) {
      assert.equal(isBlockReasonCode(hostile), false, hostile);
    }
  });

  test("every code carries a caller-facing sentence", () => {
    for (const [code, message] of Object.entries(BLOCK_REASON_CODES)) {
      assert.equal(typeof message, "string", code);
      assert.ok(message.length > 10, code);
    }
  });
});

describe("evaluateBlock fails OPEN on anything malformed", () => {
  const snapshot = {
    blocks: [
      { accountId: 42, reasonCode: "abuse_scraping", note: "ticket 12" },
    ],
  };

  test("blocks the listed account, with the public sentence", () => {
    const verdict = evaluateBlock(snapshot, 42);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.reasonCode, "abuse_scraping");
    assert.equal(verdict.message, BLOCK_REASON_CODES.abuse_scraping);
    // The internal note can name a person, a ticket or a suspicion. It must
    // never travel to the blocked caller.
    assert.ok(!JSON.stringify(verdict).includes("ticket 12"));
  });

  test("accepts a numeric-string account id", () => {
    // accountId reaches the gate as a string (BIGSERIAL via postgres.js, and
    // String(auth.accountId) at the call site) -- the #8607 trap.
    assert.equal(evaluateBlock(snapshot, "42").blocked, true);
  });

  test("does not block an account that is not listed", () => {
    for (const id of [1, 43, "43"]) {
      assert.equal(evaluateBlock(snapshot, id).blocked, false, String(id));
    }
  });

  test("a missing, empty or malformed snapshot blocks NOBODY", () => {
    // The property that matters most in this file. A corrupt or half-written
    // blocklist reading as "blocked" would lock out every customer at once.
    for (const bad of [
      null,
      undefined,
      {},
      { blocks: null },
      { blocks: "everyone" },
      { blocks: {} },
      { blocks: 42 },
    ]) {
      assert.equal(
        evaluateBlock(bad as never, 42).blocked,
        false,
        JSON.stringify(bad),
      );
    }
  });

  test("a malformed ENTRY inside a valid snapshot does not block", () => {
    for (const entry of [null, undefined, {}, { accountId: "abc" }, 7]) {
      assert.equal(
        evaluateBlock({ blocks: [entry] } as never, 42).blocked,
        false,
        JSON.stringify(entry),
      );
    }
  });

  test("an unrecognised reason code still blocks, reported as manual", () => {
    // The account IS listed, so it stays blocked -- silently letting it through
    // because a code was mistyped would be the wrong direction. It degrades to
    // the generic code rather than leaking the raw value into a response.
    const verdict = evaluateBlock(
      { blocks: [{ accountId: 42, reasonCode: "totally-made-up" }] } as never,
      42,
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.reasonCode, "abuse_manual");
    assert.equal(verdict.message, BLOCK_REASON_CODES.abuse_manual);
  });

  test("a degenerate account id is never blocked", () => {
    for (const id of [0, -1, 1.5, "", "abc", null, undefined, {}]) {
      assert.equal(
        evaluateBlock(snapshot, id).blocked,
        false,
        JSON.stringify(id),
      );
    }
  });
});

describe("anomaly signals rank a queue, they never block", () => {
  const day = (d: string, routes: Record<string, number>): UsageDay => ({
    day: d,
    routes,
  });
  const CEILING = 1000;

  test("a quiet, focused integration raises nothing", () => {
    const signals = scoreUsageAnomalies(
      [
        day("2026-07-01", { "chain-events": 50 }),
        day("2026-07-02", { "chain-events": 60 }),
      ],
      CEILING,
    );
    assert.deepEqual(signals, []);
  });

  test("sustained ceiling-riding fires only after a RUN of days", () => {
    const heavy = (d: string) => day(d, { "chain-events": 950 });
    // One busy day is a launch or a backfill, not abuse.
    assert.deepEqual(scoreUsageAnomalies([heavy("2026-07-01")], CEILING), []);
    const run = Array.from({ length: SUSTAINED_CEILING_MIN_DAYS }, (_, i) =>
      heavy(`2026-07-0${i + 1}`),
    );
    const signals = scoreUsageAnomalies(run, CEILING);
    assert.equal(signals[0].code, "sustained_ceiling");
    assert.ok(signals[0].score > 0);
  });

  test("the ceiling score saturates instead of growing forever", () => {
    // A 30-day run is not meaningfully more suspicious than a 6-day one, and an
    // unbounded score would pin every long-lived heavy user to the top of the
    // queue permanently.
    const long = Array.from({ length: 30 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, "0")}`, { mcp: 950 }),
    );
    const signals = scoreUsageAnomalies(long, CEILING);
    assert.equal(signals[0].score, 1);
  });

  test("no ceiling means no ceiling signal, rather than a divide-by-zero", () => {
    for (const ceiling of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const signals = scoreUsageAnomalies(
        [day("2026-07-01", { mcp: 1e9 })],
        ceiling,
      );
      assert.ok(!signals.some((s) => s.code === "sustained_ceiling"));
    }
  });

  test("route spread fires on breadth, which is the scraping shape", () => {
    const routes: Record<string, number> = {};
    for (let i = 0; i < ROUTE_SPREAD_MIN_ROUTES; i += 1) routes[`r${i}`] = 10;
    const signals = scoreUsageAnomalies([day("2026-07-01", routes)], CEILING);
    assert.ok(signals.some((s) => s.code === "route_spread"));
  });

  test("single-route concentration needs VOLUME, not just focus", () => {
    // A small single-purpose integration is focused by design and must never
    // be flagged for it.
    const small = scoreUsageAnomalies(
      [day("2026-07-01", { "chain-events": 100 })],
      1e9,
    );
    assert.ok(!small.some((s) => s.code === "single_route_concentration"));

    const big = scoreUsageAnomalies(
      [day("2026-07-01", { "chain-events": SINGLE_ROUTE_MIN_REQUESTS })],
      1e9,
    );
    assert.ok(big.some((s) => s.code === "single_route_concentration"));
  });

  test("signals come back strongest first", () => {
    const routes: Record<string, number> = { "chain-events": 100_000 };
    for (let i = 0; i < ROUTE_SPREAD_MIN_ROUTES; i += 1) routes[`r${i}`] = 1;
    const signals = scoreUsageAnomalies(
      [
        day("2026-07-01", routes),
        day("2026-07-02", routes),
        day("2026-07-03", routes),
      ],
      CEILING,
    );
    assert.ok(signals.length > 1);
    for (let i = 1; i < signals.length; i += 1) {
      assert.ok(signals[i - 1].score >= signals[i].score);
    }
  });

  test("degenerate input yields no signals rather than throwing", () => {
    for (const input of [null, undefined, [], [null], [{}], [{ day: 1 }]]) {
      assert.deepEqual(scoreUsageAnomalies(input as never, CEILING), []);
    }
    // Non-numeric counts must not poison the totals into NaN comparisons.
    assert.deepEqual(
      scoreUsageAnomalies(
        [day("2026-07-01", { a: Number.NaN, b: "x" as unknown as number })],
        CEILING,
      ),
      [],
    );
  });

  test("every signal is advisory: none of them carries a block", () => {
    // The structural guarantee. If a `block` field ever appears on a signal,
    // this fails -- automated blocking on a heuristic like "used many route
    // families" would eventually cut off a legitimate integration.
    const routes: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) routes[`r${i}`] = 100_000;
    const signals = scoreUsageAnomalies(
      Array.from({ length: 30 }, (_, i) =>
        day(`2026-07-${String(i + 1).padStart(2, "0")}`, routes),
      ),
      1,
    );
    assert.ok(signals.length > 0);
    for (const signal of signals) {
      assert.ok(!("block" in signal));
      assert.ok(signal.score >= 0 && signal.score <= 1);
      assert.equal(typeof signal.detail, "string");
    }
  });
});

describe("runAbuseScan reports, it does not enforce (#8611)", () => {
  const okUpstream = (flagged: number) => ({
    fetch: async (request: Request) => {
      calls.push({
        url: new URL(request.url).pathname + new URL(request.url).search,
        token: request.headers.get("x-api-key-block-token"),
      });
      return Response.json({
        window_days: 7,
        accounts_seen: 12,
        flagged_count: flagged,
        flagged: [],
      });
    },
  });
  let calls: { url: string; token: string | null }[] = [];
  let captured: { url: string; body?: unknown }[] = [];

  const envWith = (over: Record<string, unknown> = {}) =>
    ({
      DATA_API: okUpstream(2),
      API_KEY_BLOCK_INTERNAL_TOKEN: "block-token",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      ...over,
    }) as unknown as Env;

  beforeEach(() => {
    calls = [];
    captured = [];
    vi.stubGlobal(
      "fetch",
      async (url: unknown, init: Record<string, unknown>) => {
        captured.push({ url: String(url), body: init?.body });
        return { ok: true, status: 200, json: async () => ({}) };
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test("queries the anomalies route with its own token and reports a spike", async () => {
    const { runAbuseScan } = await import("../workers/api.ts");
    const waited: Promise<unknown>[] = [];
    const result = await runAbuseScan(envWith(), {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    assert.deepEqual(result, { ok: true, flagged: 2, accountsSeen: 12 });
    assert.equal(calls[0].url, "/api/v1/internal/keys/anomalies?days=7");
    assert.equal(calls[0].token, "block-token");
    await Promise.all(waited);
    // Reported to the ops channel -- and nothing else. No block was issued.
    assert.equal(captured.length, 1);
    assert.ok(captured[0].url.includes("posthog"));
  });

  test("stays QUIET when nothing is flagged", async () => {
    // A daily "0 flagged" event trains whoever watches the channel to skip it.
    const { runAbuseScan } = await import("../workers/api.ts");
    const waited: Promise<unknown>[] = [];
    const result = await runAbuseScan(envWith({ DATA_API: okUpstream(0) }), {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    assert.deepEqual(result, { ok: true, flagged: 0, accountsSeen: 12 });
    await Promise.all(waited);
    assert.equal(captured.length, 0);
  });

  test("works without an ExecutionContext, reporting inline", async () => {
    // The cron path always has a ctx, but runAbuseScan is exported and a
    // caller without one must not blow up on `ctx.waitUntil`.
    const { runAbuseScan } = await import("../workers/api.ts");
    const result = await runAbuseScan(envWith());
    assert.deepEqual(result, { ok: true, flagged: 2, accountsSeen: 12 });
  });

  test("the daily cron dispatches to it", async () => {
    // Registering the trigger in wrangler.jsonc without wiring the branch would
    // fire a cron into a silent no-op every day.
    const { default: worker } = await import("../workers/api.ts");
    const { ABUSE_SCAN_CRON } = await import("../workers/config.ts");
    const waited: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: ABUSE_SCAN_CRON, scheduledTime: Date.now() } as never,
      envWith() as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    );
    await Promise.all(waited);
    assert.equal(calls[0]?.url, "/api/v1/internal/keys/anomalies?days=7");
  });

  test("a failed ops-channel report does not fail the scan", async () => {
    // The scan's job is to look; telling PostHog is best-effort. A telemetry
    // outage must not turn the daily scan into a failing cron.
    vi.stubGlobal("fetch", async () => {
      throw new Error("posthog down");
    });
    const { runAbuseScan } = await import("../workers/api.ts");
    const waited: Promise<unknown>[] = [];
    const result = await runAbuseScan(envWith(), {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    assert.deepEqual(result, { ok: true, flagged: 2, accountsSeen: 12 });
    // The swallowed rejection must not surface as an unhandled rejection.
    assert.deepEqual(await Promise.all(waited), [false]);
  });

  test("a missing binding or token is a no-op, not a throw", async () => {
    const { runAbuseScan } = await import("../workers/api.ts");
    assert.deepEqual(await runAbuseScan(envWith({ DATA_API: undefined })), {
      ok: false,
      reason: "not_provisioned",
    });
    assert.deepEqual(
      await runAbuseScan(envWith({ API_KEY_BLOCK_INTERNAL_TOKEN: undefined })),
      { ok: false, reason: "not_provisioned" },
    );
  });

  test("an upstream failure is one missed report, never an outage", async () => {
    const { runAbuseScan } = await import("../workers/api.ts");
    assert.deepEqual(
      await runAbuseScan(
        envWith({
          DATA_API: { fetch: async () => new Response("", { status: 503 }) },
        }),
      ),
      { ok: false, reason: "upstream_503" },
    );
    assert.deepEqual(
      await runAbuseScan(
        envWith({
          DATA_API: {
            fetch: async () => {
              throw new Error("unreachable");
            },
          },
        }),
      ),
      { ok: false, reason: "unreachable" },
    );
  });

  test("a malformed upstream body degrades to zero rather than NaN", async () => {
    const { runAbuseScan } = await import("../workers/api.ts");
    const result = await runAbuseScan(
      envWith({
        DATA_API: { fetch: async () => Response.json({ nonsense: true }) },
      }),
    );
    assert.deepEqual(result, { ok: true, flagged: 0, accountsSeen: 0 });
  });
});
