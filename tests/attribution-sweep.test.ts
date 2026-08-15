// #10489-#10509: the attribution sweep.
//
// The interesting assertions are all about what the lane REFUSES to conclude.
// It produces candidates, not attributions; it separates "we looked and found
// nothing" from "we could not look" and from "there was nothing to look at";
// and a checksum-invalid string is not a near-miss, it is not an address.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { SEND_BATCH_MAX } from "../src/lane-queue.ts";
import worker, {
  fetchSweepText,
  handleScheduled,
  sweepRecordFor,
  sweepableSubnets,
} from "../workers/api.ts";
import { LANE_HEARTBEAT_CRON } from "../workers/config.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
import {
  enqueueSweeps,
  handleSweepBatch,
  type SweepMessage,
  SWEEP_MAX_BYTES,
  SWEEP_MAX_SOURCES,
  loadSweepRecord,
  persistSweep,
  ss58Candidates,
  sweepSubnet,
  sweepVerdict,
  sweepableSources,
  type SweepResult,
} from "../src/attribution-sweep.ts";

const REAL = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const ALSO_REAL = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";
const NOW = Date.parse("2026-08-11T00:00:00Z");

function record(surfaces: Array<Record<string, unknown>>) {
  return { netuid: 64, surfaces };
}

/** One lane's entry in the heartbeat's aggregate result. The heartbeat runs
 * every producer, so a per-lane assertion has to look its own up. */
function laneResult(result: unknown) {
  const lanes = (result as { lanes?: Array<Record<string, unknown>> }).lanes;
  const found = (lanes ?? []).find((l) => l.lane === "attribution-sweep");
  assert.ok(found, "attribution-sweep must be in LANE_PRODUCERS");
  return found as { ok: boolean; enqueued: number; reason?: string };
}

describe("finding ss58 strings", () => {
  test("finds a real address in surrounding prose", () => {
    assert.deepEqual(
      ss58Candidates(`Our treasury is ${REAL}, published here.`),
      [REAL],
    );
  });

  test("REJECTS a checksum-invalid string that looks the part", () => {
    // A base58 run of the right shape is not "probably an address". The
    // checksum is the difference between a candidate and a typo, and a typo
    // put in front of a reviewer as a candidate wastes exactly the attention
    // this lane exists to focus.
    const corrupted = REAL.slice(0, -1) + (REAL.endsWith("9") ? "8" : "9");
    assert.deepEqual(ss58Candidates(corrupted), []);
  });

  test("does not match a base58 id of the wrong length", () => {
    assert.deepEqual(ss58Candidates("5Grwva 5abc 5" + "z".repeat(60)), []);
  });

  test("deduplicates one address repeated on a page", () => {
    assert.deepEqual(ss58Candidates(`${REAL} ... ${REAL}`), [REAL]);
  });

  test("finds several distinct addresses", () => {
    const found = ss58Candidates(`${REAL} and ${ALSO_REAL}`);
    assert.deepEqual(found.sort(), [REAL, ALSO_REAL].sort());
  });
});

describe("choosing what to fetch", () => {
  test("takes the surfaces a team would publish an address on", () => {
    assert.deepEqual(
      sweepableSources(
        record([
          { kind: "website", url: "https://example.org/" },
          { kind: "docs", url: "https://example.org/docs" },
          // Not swept: nobody publishes a treasury address in a metagraph dump,
          // and fetching it would spend the budget on noise.
          { kind: "openapi", url: "https://example.org/openapi.json" },
        ]),
      ),
      ["https://example.org/", "https://example.org/docs"],
    );
  });

  test("skips a non-http surface rather than counting it as checked", () => {
    // Counting an unreachable-by-construction source would overstate the reach
    // and make a `none-published` verdict look better sourced than it is.
    assert.deepEqual(
      sweepableSources(
        record([
          { kind: "website", url: "wss://example.org/ws" },
          { kind: "website", url: "" },
          { kind: "website" },
        ]),
      ),
      [],
    );
  });

  test("caps the fan-out per subnet", () => {
    const many = Array.from({ length: SWEEP_MAX_SOURCES + 5 }, (_, i) => ({
      kind: "docs",
      url: `https://example.org/${i}`,
    }));
    assert.equal(sweepableSources(record(many)).length, SWEEP_MAX_SOURCES);
  });

  test("a subnet with no surfaces yields nothing to fetch", () => {
    assert.deepEqual(sweepableSources(null), []);
    assert.deepEqual(sweepableSources({}), []);
    assert.deepEqual(sweepableSources({ surfaces: "nope" }), []);
  });
});

describe("the verdict separates the four states", () => {
  test("`no-sources` is not `none-published`", () => {
    // We did not look. Reporting that as "looked, found nothing" would be a
    // finding about a subnet built out of our own absence of effort.
    assert.equal(sweepVerdict(0, 0, 0), "no-sources");
  });

  test("`unreachable` is not `none-published` either", () => {
    // We tried and reached none. That is a statement about us.
    assert.equal(sweepVerdict(3, 0, 0), "unreachable");
  });

  test("reading at least one source and finding nothing IS a finding", () => {
    assert.equal(sweepVerdict(3, 1, 0), "none-published");
  });

  test("anything found is a candidate, never a conclusion", () => {
    assert.equal(sweepVerdict(3, 3, 2), "candidates-found");
  });
});

describe("sweeping one subnet", () => {
  const source = (body: Record<string, string>) => ({
    fetchText: async (url: string) => body[url] ?? null,
    now: () => NOW,
  });

  test("records what was read, and what was found where", async () => {
    const out = await sweepSubnet(
      64,
      record([
        { kind: "website", url: "https://a.example/" },
        { kind: "docs", url: "https://b.example/" },
      ]),
      source({ "https://a.example/": `treasury: ${REAL}` }),
    );
    assert.equal(out.sources_checked, 2);
    assert.equal(out.sources_read, 1, "the second source answered nothing");
    assert.deepEqual(out.candidates, [
      { ss58: REAL, source_url: "https://a.example/" },
    ]);
    assert.equal(out.verdict, "candidates-found");
    assert.equal(out.swept_at, NOW);
  });

  test("a source that THROWS is checked but not read", async () => {
    // The gap between checked and read is the reach we did not have, and
    // rolling a thrown fetch into the finding would hide it.
    const out = await sweepSubnet(
      64,
      record([{ kind: "website", url: "https://a.example/" }]),
      {
        fetchText: async () => {
          throw new Error("connection reset");
        },
        now: () => NOW,
      },
    );
    assert.equal(out.sources_checked, 1);
    assert.equal(out.sources_read, 0);
    assert.equal(out.verdict, "unreachable");
  });

  test("reading a source with no address is the expected answer", async () => {
    const out = await sweepSubnet(
      64,
      record([{ kind: "website", url: "https://a.example/" }]),
      source({ "https://a.example/": "<html>no addresses here</html>" }),
    );
    assert.equal(out.verdict, "none-published");
    assert.deepEqual(out.candidates, []);
    assert.equal(out.sources_read, 1);
  });

  test("a subnet declaring nothing fetchable is never `none-published`", async () => {
    const out = await sweepSubnet(64, record([]), source({}));
    assert.equal(out.verdict, "no-sources");
    assert.equal(out.sources_checked, 0);
  });

  test("defaults to the wall clock when no clock is injected", async () => {
    const before = Date.now();
    const out = await sweepSubnet(64, record([]), {
      fetchText: async () => null,
    });
    assert.ok(out.swept_at >= before);
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

  const result: SweepResult = {
    netuid: 64,
    swept_at: NOW,
    sources_checked: 2,
    sources_read: 2,
    candidates: [{ ss58: REAL, source_url: "https://a.example/" }],
    verdict: "candidates-found",
  };

  test("upserts the sweep and each candidate", async () => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const out = await persistSweep(db(calls), result);
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2);
    // Postgres rejects INSERT OR REPLACE outright -- that spelling is how the
    // burn lane's every write failed silently on Neon (#10172).
    for (const call of calls) {
      assert.match(call.sql, /ON CONFLICT/);
      assert.doesNotMatch(call.sql, /INSERT OR REPLACE/);
    }
    assert.match(calls[1].sql, /last_seen = EXCLUDED\.last_seen/);
    assert.doesNotMatch(
      calls[1].sql,
      /first_seen = EXCLUDED/,
      "first_seen must survive, or a vanished address loses the date it appeared",
    );
  });

  test("no binding is a stated refusal, not a silent success", async () => {
    assert.deepEqual(await persistSweep(null, result), {
      ok: false,
      reason: "no_store_binding",
    });
  });

  test("a write failure is reported rather than swallowed", async () => {
    const out = await persistSweep(
      {
        run() {
          throw new Error("relation does not exist");
        },
      },
      result,
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /relation does not exist/);
  });

  test("reads a subnet's state back, as an ISO date", async () => {
    const out = await loadSweepRecord(
      db(
        [],
        [
          {
            swept_at: NOW,
            sources_checked: 2,
            sources_read: 2,
            candidates: 0,
            verdict: "none-published",
          },
        ],
      ),
      64,
    );
    assert.equal(out?.swept_at, "2026-08-11T00:00:00.000Z");
    assert.equal(out?.verdict, "none-published");
  });

  test("an unswept subnet reads as null, not as a zeroed sweep", async () => {
    // A synthesised "checked 0, found 0" would claim we looked.
    assert.equal(await loadSweepRecord(db([], []), 64), null);
  });

  test("a failed read is null too, and never a fabricated finding", async () => {
    assert.equal(await loadSweepRecord(null, 64), null);
    assert.equal(
      await loadSweepRecord(
        {
          query() {
            throw new Error("store unavailable");
          },
        },
        64,
      ),
      null,
    );
  });

  test("a corrupt timestamp nulls the date rather than inventing 1970", async () => {
    const out = await loadSweepRecord(
      db([], [{ swept_at: "not a number", verdict: "none-published" }]),
      64,
    );
    assert.equal(out?.swept_at, null);
    assert.equal(out?.sources_checked, 0);
  });
});

describe("the wiring — a correct lane nobody calls is the defect", () => {
  test("the cron expression is registered as a trigger", async () => {
    // Code and trigger deploy by different mechanisms: Workers Builds ships the
    // former and not the latter. A constant with no matching entry here never
    // fires, which looks exactly like a lane that ran and found nothing.
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.ok(
      wrangler.includes(`"${LANE_HEARTBEAT_CRON}"`),
      `${LANE_HEARTBEAT_CRON} is not in wrangler.jsonc triggers.crons`,
    );
  });

  test("the cron does not collide with another lane", () => {
    // Dispatch keys on the literal expression, so two lanes sharing one string
    // means the first branch wins and the second silently never runs.
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
    // The cron no longer sweeps -- it enqueues. With no artifact there is
    // nothing to enqueue, and the producer must say so rather than report a
    // pass with nothing sent.
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        {} as unknown as Parameters<typeof handleScheduled>[1],
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.enqueued, 0);
    // The BINDING is reported before the empty list, and that order is the
    // useful one: a missing binding is a config error, and saying "no subnets"
    // would send someone looking at the registry instead.
    assert.equal(result.reason, "no_queue_binding");
  });

  // This test's flag-declared premise retired with NEON_SOLE_STORE_TABLES
  // (#10051): Neon is the only store, so an undeclared/partial state cannot
  // exist. "A reader names a table no migration creates" is owned by
  // tests/neon-sole-store-tables-exist.test.ts, derived from the code.

  test("the migration declares both tables and their verdict vocabulary", async () => {
    const sql = await fs.readFile(
      path.join(repoRoot, "migrations/neon/0018_attribution_sweeps.sql"),
      "utf8",
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS attribution_sweeps/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS attribution_candidates/);
    // The four verdicts the code emits must all be storable, or a pass that
    // reaches nothing fails its write instead of recording that it reached
    // nothing.
    for (const verdict of [
      "none-published",
      "candidates-found",
      "unreachable",
      "no-sources",
    ]) {
      assert.ok(sql.includes(`'${verdict}'`), `${verdict} is not storable`);
    }
  });
});

describe("the worker's two halves of the lane", () => {
  /** BOTH bindings stubbed: readArtifact picks a storage tier per path, and
   * /metagraph/subnets.json is r2-tier -- an ASSETS-only env serves nothing for
   * it and the test would pass while proving nothing. */
  /** TWO artifacts, keyed by path, because the lane reads two.
   *
   * The single-payload version this replaces answered every path with the
   * subnet list, which is precisely how #10818 stayed invisible: the fixtures
   * put `surfaces` on the list record, the published artifact never has, and a
   * helper that serves one blob for any path cannot tell those apart. */
  function artifactEnv(payload: unknown, surfacesPayload?: unknown) {
    const bodies = new Map<string, unknown>();
    if (payload != null) bodies.set("/metagraph/subnets.json", payload);
    if (surfacesPayload != null) {
      bodies.set("/metagraph/surfaces.json", surfacesPayload);
    }
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          const body = bodies.get(pathname);
          return body != null
            ? Response.json(body as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          const body = bodies.get(pathname);
          return body != null
            ? {
                async json() {
                  return body;
                },
              }
            : null;
        },
      },
    };
  }

  /** An env serving ONE subnet's `/metagraph/surfaces/{netuid}.json`, which is
   * the artifact the resolver reads. `null` body means the artifact is absent,
   * which must not read as "the subnet declares nothing". */
  function surfaceEnv(netuid: number, body: unknown) {
    const target = `/metagraph/surfaces/${netuid}.json`;
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return pathname === target && body != null
            ? Response.json(body as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          return p === target && body != null
            ? {
                async json() {
                  return body;
                },
              }
            : null;
        },
      },
    };
  }

  /** The shape `/metagraph/surfaces.json` actually publishes: one flat list,
   * each surface carrying its own `netuid`. */
  function surfacesArtifact(
    rows: Array<{ netuid: unknown; kind?: string; url?: string }>,
  ) {
    return { surfaces: rows };
  }

  test("reads the subnet list from the served artifact, skipping root", async () => {
    // Root is emission-ineligible, so there is no owner cut to account for and
    // nothing this sweep is looking for on its behalf.
    const out = await sweepableSubnets(
      artifactEnv(
        // NO `surfaces` on the list record -- that is the published shape, and
        // fixtures that invent one are what hid #10818 for the lane's whole life.
        {
          subnets: [{ netuid: 0 }, { netuid: 64 }, { netuid: "nope" }, null],
        },
        surfacesArtifact([
          { netuid: 0, kind: "docs", url: "https://root.test" },
          { netuid: 64, kind: "docs", url: "https://sixtyfour.test" },
        ]),
      ) as never,
    );
    assert.deepEqual(
      out.map((s) => s.netuid),
      [64],
    );
  });

  test("no artifact is an empty list, never a throw", async () => {
    const env = {
      ASSETS: {
        async fetch() {
          return new Response("{}", { status: 404 });
        },
      },
    };
    assert.deepEqual(await sweepableSubnets(env as never), []);
  });

  test("a non-array subnets key is not iterated", async () => {
    // The surfaces artifact is supplied so this reaches the subnet loop at all:
    // without it the missing-artifact guard returns first and the assertion
    // would pass for the wrong reason.
    assert.deepEqual(
      await sweepableSubnets(
        artifactEnv({ subnets: "not a list" }, surfacesArtifact([])) as never,
      ),
      [],
    );
  });

  test("surfaces come from the per-subnet SURFACES artifact, not the subnet list", async () => {
    // THE BUG THIS LANE SHIPPED WITH. /metagraph/subnets.json publishes
    // `surface_count` and never `surfaces[]`, so every sweep read undefined and
    // recorded `no-sources`. Measured 2026-08-14: 128 sweeps, 0 sources
    // checked, 0 candidates, against 2,900 sweepable surfaces published.
    const record = await sweepRecordFor(
      surfaceEnv(64, {
        surfaces: [
          { kind: "docs", url: "https://example.com/docs" },
          { kind: "website", url: "https://example.com" },
          { kind: "openapi", url: "https://example.com/openapi.json" },
        ],
      }) as never,
      64,
      { netuid: 64, surface_count: 3 },
    );
    assert.deepEqual(sweepableSources(record), [
      "https://example.com/docs",
      "https://example.com",
    ]);
  });

  test("a subnet that is no longer registered resolves to null, not an empty sweep", async () => {
    // Enqueued, then delisted. A resolved absence, which the consumer records
    // as such -- distinct from a subnet we could not read.
    assert.equal(
      await sweepRecordFor(
        surfaceEnv(64, { surfaces: [] }) as never,
        64,
        undefined,
      ),
      null,
    );
  });

  test("an UNREADABLE surfaces artifact THROWS rather than sweeping with none", async () => {
    // `no-sources` is a claim about the SUBNET. Publishing it because OUR
    // artifact was unavailable would be a finding built out of our own outage
    // -- the conflation `unreachable` exists to prevent. A throw retries the
    // message instead of persisting a false negative.
    await assert.rejects(
      () => sweepRecordFor(surfaceEnv(64, null) as never, 64, { netuid: 64 }),
      /surfaces artifact unavailable/,
    );
  });

  test("a non-array surfaces key resolves to an empty list, not undefined", async () => {
    const record = await sweepRecordFor(
      surfaceEnv(64, { surfaces: "not a list" }) as never,
      64,
      { netuid: 64 },
    );
    assert.deepEqual((record as { surfaces: unknown }).surfaces, []);
    assert.deepEqual(sweepableSources(record), []);
  });

  test("against the REAL published artifacts, the lane finds sources to sweep", async () => {
    // THE GUARD THAT WOULD HAVE CAUGHT #10818, and the reason it is bound to
    // the built tree rather than a fixture.
    //
    // Every unit test above passes hand-made records, so all of them stayed
    // green while the lane read `surfaces` from an artifact that has never
    // published it -- 128 sweeps, 0 sources checked, for the lane's whole life.
    // A fixture can only prove the code agrees with the fixture.
    //
    // This asserts the contract that actually matters: fed the artifacts this
    // repo really publishes, the sweep has something to fetch. If either
    // artifact's shape moves again, this fails here instead of turning into
    // 129 silent `no-sources` rows in production.
    const env = createLocalArtifactEnv() as never;
    const subnets = await sweepableSubnets(env);
    assert.ok(
      subnets.length > 100,
      `expected the fleet, got ${subnets.length}`,
    );
    let withSources = 0;
    for (const { netuid, record } of subnets.slice(0, 25)) {
      const resolved = await sweepRecordFor(env, netuid, record);
      if (sweepableSources(resolved).length > 0) withSources += 1;
    }
    // Measured 2026-08-14: 2,900 sweepable http(s) surfaces, and EVERY subnet
    // carries at least one. A floor rather than an exact count, so adding or
    // retiring a surface does not fail an unrelated PR.
    assert.ok(
      withSources > 12,
      `only ${withSources}/25 sampled subnets have a sweepable source`,
    );
  });

  test("fetching a source truncates, and any failure is null", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("x".repeat(SWEEP_MAX_BYTES + 500))) as typeof fetch;
      const text = await fetchSweepText("https://a.example/");
      assert.equal(text?.length, SWEEP_MAX_BYTES);

      globalThis.fetch = (async () =>
        new Response("nope", { status: 500 })) as typeof fetch;
      assert.equal(await fetchSweepText("https://a.example/"), null);

      globalThis.fetch = (async () => {
        throw new Error("connection reset");
      }) as typeof fetch;
      assert.equal(await fetchSweepText("https://a.example/"), null);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("shapes the registry and the store can really produce", () => {
  test("a null surface entry and a kindless one are skipped", () => {
    assert.deepEqual(
      sweepableSources({ surfaces: [null, { url: "https://a.example/" }] }),
      [],
    );
  });

  test("a thrown non-Error still names the failure", async () => {
    const out = await persistSweep(
      {
        run() {
          throw "a bare string";
        },
      },
      {
        netuid: 64,
        swept_at: NOW,
        sources_checked: 0,
        sources_read: 0,
        candidates: [],
        verdict: "no-sources",
      },
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /a bare string/);
  });

  // "a driver returning no results key" retired with D1's envelope
  // (#10309): query() answers rows directly, so there is no envelope whose
  // absence needs a reading. The unswept case is the empty array, pinned
  // above.

  test("a row with no verdict reads as null, not as a finding", async () => {
    const db = {
      query: async <T>() => [{ swept_at: NOW }] as T[],
    };
    const out = await loadSweepRecord(db, 64);
    assert.equal(out?.verdict, null);
  });
});

describe("the queue lane", () => {
  function queue(sent: Array<Array<{ body: unknown }>>, fail = false) {
    return {
      async sendBatch(messages: Array<{ body: SweepMessage }>) {
        if (fail) throw new Error("queue unavailable");
        sent.push(messages);
      },
    };
  }

  test("enqueues EVERY subnet, not a slice", async () => {
    // The slice of eight the cron swept was never a cadence -- it was the
    // invocation budget. A queue removes the constraint, so the producer
    // rations nothing.
    const sent: Array<Array<{ body: unknown }>> = [];
    const out = await enqueueSweeps(queue(sent), [1, 2, 3]);
    assert.deepEqual(out, { ok: true, enqueued: 3 });
    assert.deepEqual(
      sent[0].map((m) => (m.body as SweepMessage).netuid),
      [1, 2, 3],
    );
  });

  test("splits at the sendBatch cap", async () => {
    // 128 subnets is one over two batches at Cloudflare's 100-message cap --
    // exactly the off-by-one that ships.
    const sent: Array<Array<{ body: unknown }>> = [];
    const many = Array.from({ length: SEND_BATCH_MAX + 28 }, (_, i) => i);
    const out = await enqueueSweeps(queue(sent), many);
    assert.equal(out.enqueued, many.length);
    assert.deepEqual(
      sent.map((b) => b.length),
      [SEND_BATCH_MAX, 28],
    );
  });

  test("no binding and an empty list are both stated refusals", async () => {
    assert.deepEqual(await enqueueSweeps(null, [1]), {
      ok: false,
      enqueued: 0,
      reason: "no_queue_binding",
    });
    // A producer reporting ok while enqueuing nothing is indistinguishable
    // from one that enqueued and found nothing to do.
    assert.deepEqual(await enqueueSweeps(queue([]), []), {
      ok: false,
      enqueued: 0,
      reason: "no_subnets_to_sweep",
    });
  });

  test("a partial send reports what actually went out", async () => {
    const out = await enqueueSweeps(queue([], true), [1, 2]);
    assert.equal(out.ok, false);
    assert.equal(out.enqueued, 0);
    assert.match(String(out.reason), /queue unavailable/);
  });
});

describe("consuming a sweep batch", () => {
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

  const deps = (
    over: Partial<Parameters<typeof handleSweepBatch>[2]> = {},
  ) => ({
    fetchText: async () => "nothing here",
    now: () => NOW,
    recordFor: async () => ({
      netuid: 1,
      surfaces: [{ kind: "website", url: "https://a.example/" }],
    }),
    ...over,
  });

  test("acks a swept subnet", async () => {
    const m = message({ netuid: 64 });
    const out = await handleSweepBatch([m], store(), deps());
    assert.deepEqual(out, {
      done: 1,
      retried: 0,
      dropped: 0,
      firstFailure: null,
    });
    assert.equal(m.calls.acked, 1);
  });

  test("reads the registry record at DELIVERY time, not from the message", async () => {
    // A message that waited in the queue must not sweep a stale copy of the
    // subnet's surfaces -- which is why the body carries only a netuid.
    let askedFor: number | null = null;
    const m = message({ netuid: 51 });
    await handleSweepBatch(
      [m],
      store(),
      deps({
        recordFor: async (netuid: number) => {
          askedFor = netuid;
          return { netuid, surfaces: [] };
        },
      }),
    );
    assert.equal(askedFor, 51);
  });

  test("RETRIES a subnet whose fetch throws, instead of dropping it", async () => {
    // Under the cron this subnet was simply lost until the next hour came
    // round to it again. Now the queue re-delivers it.
    const m = message({ netuid: 64 });
    const out = await handleSweepBatch(
      [m],
      store(),
      deps({
        fetchText: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    );
    // The sweep itself absorbs a fetch failure as `unreachable`, so this acks.
    assert.equal(out.done + out.retried, 1);
    assert.equal(m.calls.acked + m.calls.retried, 1);
  });

  test("RETRIES when the sweep succeeded but the WRITE failed", async () => {
    // An unwritten sweep is a sweep that did not happen, as far as anything
    // reading the store is concerned.
    const m = message({ netuid: 64 });
    const out = await handleSweepBatch([m], null, deps());
    assert.deepEqual(out, {
      done: 0,
      retried: 1,
      dropped: 0,
      // THE REASON, not the generic decline. The store already knew why --
      // there is no db here -- and collapsing that to `false` is what left
      // production reading "run() declined without throwing", which names the
      // lane and not the fault.
      firstFailure: "no_store_binding",
    });
    assert.equal(m.calls.retried, 1);
  });

  test("ACKS a malformed message rather than looping it to the dead letter", async () => {
    // A body that is not a netuid never will be. Retrying spends the whole
    // budget to reach the DLQ with a message nobody can act on.
    const bad = [
      message({ netuid: "sixty-four" }),
      message({}),
      message(null),
      message({ netuid: -1 }),
    ];
    const out = await handleSweepBatch(bad, store(), deps());
    assert.deepEqual(out, {
      done: 0,
      retried: 0,
      dropped: 4,
      firstFailure: null,
    });
    for (const m of bad) assert.equal(m.calls.acked, 1);
  });

  test("one bad message does not stop the rest of the batch", async () => {
    const good = message({ netuid: 64 });
    const out = await handleSweepBatch(
      [message(null), good, message({})],
      store(),
      deps(),
    );
    assert.equal(out.done, 1);
    assert.equal(out.dropped, 2);
    assert.equal(good.calls.acked, 1);
  });
});

describe("the queue wiring", () => {
  test("the dead-letter queue is registered as a lane", async () => {
    // A DLQ nobody consumes is a second log: the message lands, sits for the
    // retention, and disappears (#354/#363).
    const source = await fs.readFile(
      path.join(repoRoot, "src/dead-letter.ts"),
      "utf8",
    );
    assert.match(source, /"probe-jobs-dlq"/);
  });

  test("both queues are declared in wrangler, with a dead letter", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.match(wrangler, /"binding": "PROBE_JOBS"/);
    assert.match(wrangler, /"queue": "probe-jobs"/);
    assert.match(wrangler, /"dead_letter_queue": "probe-jobs-dlq"/);
    assert.match(wrangler, /"queue": "probe-jobs"/);
  });

  test("the consumer branches on the queue name before the webhook path", async () => {
    // Both queues bind to one `queue()` export. Without the branch a sweep
    // message would be handed to the webhook deliverer.
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /"attribution-sweep": run[A-Za-z]+Jobs,/);
  });
});

describe("the queue consumer, through the Worker's own handler", () => {
  /** The registry artifact plus a queue binding, as the Worker sees them. */
  /** Per-PATH bodies: the consumer reads the subnet list AND, for each message,
   * that subnet's `/metagraph/surfaces/{netuid}.json`. A helper that answered
   * every path with one payload is what let #10818 hide. */
  function queueEnv(
    payload: unknown,
    surfacesByNetuid: Record<number, unknown> = {},
  ) {
    const bodies = new Map<string, unknown>();
    if (payload != null) bodies.set("/metagraph/subnets.json", payload);
    for (const [netuid, body] of Object.entries(surfacesByNetuid)) {
      if (body != null) bodies.set(`/metagraph/surfaces/${netuid}.json`, body);
    }
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          const body = bodies.get(pathname);
          return body != null
            ? Response.json(body as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          const body = bodies.get(p);
          return body != null
            ? {
                async json() {
                  return body;
                },
              }
            : null;
        },
      },
    };
  }

  test("the CONSUMER resolves surfaces and actually fetches them", async () => {
    // THE WIRING, not the resolver. Every other test here calls
    // `sweepRecordFor` directly, so reverting the consumer back to handing the
    // bare list record straight to the sweep left all of them green -- which is
    // the same shape of hole that let #10818 ship. This one drives
    // `worker.queue` and asserts a real URL was requested.
    const fetched: string[] = [];
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response("nothing here");
      }) as typeof fetch;
      await worker.queue!(
        {
          queue: "probe-jobs",
          messages: [
            {
              body: { job_type: "attribution-sweep", netuid: 64 },
              ack: () => {},
              retry: () => {},
            },
          ],
        } as never,
        queueEnv(
          { subnets: [{ netuid: 64 }] },
          {
            64: {
              surfaces: [{ kind: "docs", url: "https://swept.test/docs" }],
            },
          },
        ) as never,
        { waitUntil: () => {} } as never,
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(fetched, ["https://swept.test/docs"]);
  });

  test("a sweep batch is routed to the sweep consumer, not the webhook path", async () => {
    // Both queues bind to one `queue()` export. Without the branch this message
    // would be handed to the webhook deliverer.
    let acked = 0;
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: { job_type: "attribution-sweep", netuid: 64 },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    };
    await assert.doesNotReject(() =>
      worker.queue!(
        batch as never,
        queueEnv({ subnets: [{ netuid: 64 }] }) as never,
        { waitUntil: () => {} } as never,
      ),
    );
    // No store binding, so the write fails and the message is retried rather
    // than acked -- an unwritten sweep is a sweep that did not happen.
    assert.equal(acked, 0);
  });

  test("a subnet that vanished between enqueue and delivery still resolves", async () => {
    // The registry is read at delivery, so a subnet deregistered while its
    // message waited has no record. That must sweep to `no-sources` -- we did
    // not look -- rather than throw and burn the retry budget.
    let retried = 0;
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: { job_type: "attribution-sweep", netuid: 999 },
          ack: () => {},
          retry: () => void (retried += 1),
        },
      ],
    };
    await worker.queue!(
      batch as never,
      queueEnv({ subnets: [{ netuid: 64 }] }) as never,
      { waitUntil: () => {} } as never,
    );
    // No store binding, so the write fails and it retries -- but it got that
    // far, which is the point: an absent record is not an exception.
    assert.equal(retried, 1);
  });

  test("a malformed body is acked, not looped to the dead letter", async () => {
    let acked = 0;
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: { job_type: "attribution-sweep", netuid: "sixty-four" },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    };
    await worker.queue!(
      batch as never,
      queueEnv({ subnets: [] }) as never,
      { waitUntil: () => {} } as never,
    );
    assert.equal(acked, 1);
  });
});

describe("the last of the queue shapes", () => {
  test("a thrown non-Error from sendBatch still names the failure", async () => {
    const out = await enqueueSweeps(
      {
        async sendBatch() {
          throw "a bare string";
        },
      },
      [1],
    );
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /a bare string/);
  });

  test("a subnet whose RECORD read throws is retried, not dropped", async () => {
    const calls = { retried: 0 };
    const out = await handleSweepBatch(
      [
        {
          body: { job_type: "attribution-sweep", netuid: 64 },
          ack: () => {},
          retry: () => void (calls.retried += 1),
        },
      ],
      {
        run: async () => ({ changes: 1 }),
        query: async <T>() => [] as T[],
      },
      {
        fetchText: async () => null,
        now: () => NOW,
        recordFor: async () => {
          throw new Error("artifact read exploded");
        },
      },
    );
    assert.deepEqual(out, {
      done: 0,
      retried: 1,
      dropped: 0,
      // A thrown reason reaches the caller verbatim, which is what makes a
      // dead-lettering lane answerable.
      firstFailure: "artifact read exploded",
    });
    assert.equal(calls.retried, 1);
  });

  test("the cron producer enqueues when a binding IS present", async () => {
    const sent: number[] = [];
    const env = {
      ...(queueEnvFor({ subnets: [{ netuid: 7 }] }) as object),
      PROBE_JOBS: {
        async sendBatch(messages: Array<{ body: { netuid: number } }>) {
          for (const m of messages) sent.push(m.body.netuid);
        },
      },
    };
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        env as never,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.deepEqual(result, {
      lane: "attribution-sweep",
      ok: true,
      enqueued: 1,
    });
    assert.deepEqual(sent, [7]);
  });
});

/** The registry artifact alone, for the producer test above. */
/** Per-PATH bodies, because the lane reads two artifacts.
 *
 * `surfacesPayload` defaults to one sweepable surface for every subnet in the
 * list, so a test about ENQUEUEING does not have to restate the surface model
 * to say what it means. Tests that care about the surfaces artifact pass their
 * own; the one that cares about it being ABSENT passes null. */
function queueEnvFor(payload: unknown, surfacesPayload?: unknown) {
  const bodies = new Map<string, unknown>();
  if (payload != null) bodies.set("/metagraph/subnets.json", payload);
  const listed = (payload as { subnets?: unknown[] } | null)?.subnets;
  const fallback = {
    surfaces: (Array.isArray(listed) ? listed : [])
      .map((raw) => (raw ?? {}) as { netuid?: unknown })
      .filter((s) => Number.isInteger(Number(s.netuid)))
      .map((s) => ({
        netuid: Number(s.netuid),
        kind: "docs",
        url: `https://example.test/${String(s.netuid)}`,
      })),
  };
  const surfaces = surfacesPayload === undefined ? fallback : surfacesPayload;
  if (surfaces != null) bodies.set("/metagraph/surfaces.json", surfaces);
  return {
    ASSETS: {
      async fetch(request: Request) {
        const { pathname } = new URL(request.url);
        const body = bodies.get(pathname);
        return body != null
          ? Response.json(body as never)
          : new Response("{}", { status: 404 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
        const body = bodies.get(p);
        return body != null
          ? {
              async json() {
                return body;
              },
            }
          : null;
      },
    },
  };
}
