// #10566: the probe lane's store, and the wiring that gives it a caller.
//
// src/revenue-probe.ts shipped in #10444 and nothing called it — no worker
// imported it, no config carried a trigger — so `revenue_observations` was
// never written and every revenue route reported null for all 129 subnets.
//
// Nothing failed, and that is the part these tests exist to keep from
// recurring: the epic's own rule is that absent revenue serialises as null
// rather than zero, so a dead producer is indistinguishable from the correct
// answer for 127 of 129 subnets. The wiring assertions at the bottom are
// therefore as load-bearing as the store ones — a lane that is correct and
// unreachable is the state this issue was filed about.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { SEND_BATCH_MAX } from "../src/lane-queue.ts";
import {
  eligibleRevenueSurfaces,
  enqueueRevenueProbes,
  handleRevenueProbeBatch,
  fetchRevenuePayload,
  loadRevenueObservations,
  persistRevenueProbe,
  runRevenueProbeLane,
  sha256Hex,
  REVENUE_OBSERVATIONS_TABLE,
  REVENUE_PROBE_FAILURES_TABLE,
  type RevenueStoreDb,
} from "../src/revenue-observations.ts";
import worker, { handleScheduled } from "../workers/api.ts";
import { LANE_HEARTBEAT_CRON } from "../workers/config.ts";
import { REVENUE_OBSERVATION_TABLES } from "../src/read-store-tables.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Records every statement and its binds. */
function recordingDb() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db: RevenueStoreDb = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              calls.push({ sql, values });
              return {};
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

function readingDb(rows: unknown[] | null, throws = false) {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async () => {
              if (throws) throw new Error("connection reset");
              return rows === null ? null : { results: rows };
            },
          };
        },
      };
    },
  } as unknown as RevenueStoreDb;
}

const OBSERVATION = {
  surface_id: "sn-64-chutes-daily-revenue-summary",
  netuid: 64,
  period: "2026-08-08",
  grain: "daily",
  amount: 11668,
  currency: "USD",
  provenance: "probe-derived",
  response_hash: "abc",
  observed_at: 1786320000000,
};

/** One lane's entry in the heartbeat's aggregate result. The heartbeat runs
 * every producer, so a per-lane assertion has to look its own up. */
function laneResult(result: unknown) {
  const lanes = (result as { lanes?: Array<Record<string, unknown>> }).lanes;
  const found = (lanes ?? []).find((l) => l.lane === "revenue-probe");
  assert.ok(found, "revenue-probe must be in LANE_PRODUCERS");
  return found as { ok: boolean; enqueued: number; reason?: string };
}

describe("persistRevenueProbe", () => {
  test("writes observations and failures to their own tables", async () => {
    const { db, calls } = recordingDb();
    const r = await persistRevenueProbe(db, {
      observations: [OBSERVATION],
      failures: [
        {
          surface_id: "sn-51-lium-revenue-for-validators",
          netuid: 51,
          reason: "fetch failed: HTTP 503",
          observed_at: 1786320000000,
        },
      ],
      skipped: [],
    });
    assert.equal(r.ok, true);
    assert.equal(r.written, 1);
    assert.equal(r.failed, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, new RegExp(REVENUE_OBSERVATIONS_TABLE));
    assert.match(calls[1].sql, new RegExp(REVENUE_PROBE_FAILURES_TABLE));
  });

  test("a failure never becomes a zero-amount observation", async () => {
    // Two tables on purpose: a failure has no amount, and a nullable amount
    // column would invite a reader to coalesce it to 0.
    const { db, calls } = recordingDb();
    await persistRevenueProbe(db, {
      observations: [],
      failures: [
        {
          surface_id: "s",
          netuid: 1,
          reason: "fetch failed",
          observed_at: 1786320000000,
        },
      ],
      skipped: [],
    });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].sql.includes(REVENUE_OBSERVATIONS_TABLE));
    assert.ok(!calls[0].values.includes(0));
  });

  test("upserts rather than appends, because the feeds restate history", async () => {
    // SN64 publishes a rolling window of daily rows and SN51 a growing map of
    // months, so the same period is observed on every tick. Appending would
    // grow ~30 rows per surface per tick.
    const { db, calls } = recordingDb();
    await persistRevenueProbe(db, {
      observations: [OBSERVATION],
      failures: [],
      skipped: [],
    });
    assert.match(calls[0].sql, /ON CONFLICT \(surface_id, period\) DO UPDATE/);
    // Postgres rejects INSERT OR REPLACE outright — that spelling is how every
    // write in the burn lane failed silently once its table moved to Neon.
    assert.ok(!/INSERT OR REPLACE/i.test(calls[0].sql));
  });

  test("no binding is reported, not thrown", async () => {
    const r = await persistRevenueProbe(null, {
      observations: [OBSERVATION],
      failures: [],
      skipped: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_store_binding");
  });

  test("a write failure is a returned verdict, never an exception", async () => {
    // A capture lane that could take down the cron it runs on would be worse
    // than a gap in the series.
    const db = {
      prepare() {
        return {
          bind() {
            return {
              run: async () => {
                throw new Error("syntax error at or near");
              },
            };
          },
        };
      },
    } as unknown as RevenueStoreDb;
    const r = await persistRevenueProbe(db, {
      observations: [OBSERVATION],
      failures: [],
      skipped: [],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /write_failed/);
  });

  test("a pass that probed nothing says so rather than reporting success", async () => {
    // A lane silently probing an empty set looks identical to one whose every
    // surface passed — which is exactly the state this issue was filed about.
    const { db } = recordingDb();
    const r = await persistRevenueProbe(db, {
      observations: [],
      failures: [],
      skipped: [],
    });
    assert.equal(r.reason, "no_eligible_surfaces");
  });
});

describe("eligibleRevenueSurfaces", () => {
  const ARTIFACT = {
    surfaces: [
      {
        surface_id: "a",
        netuid: 64,
        url: "https://example/a",
        auth_required: false,
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          shape: "scalar",
          currency: "USD",
        },
      },
      { surface_id: "b", netuid: 2, url: "https://example/b" },
      // Annotated but not EXTRACTABLE (#10783): `extractRevenue` refuses
      // without a shape, so this is a surface the lane could fetch and never
      // read. 30 of the live artifact's 35 looked exactly like this.
      {
        surface_id: "c",
        netuid: 9,
        url: "https://example/c",
        revenue: { role: "not-revenue", provenance: "probe-derived" },
      },
    ],
  };

  test("only EXTRACTABLE surfaces are handed to the probe", () => {
    // Not merely "carries a revenue block". `extractRevenue` opens with
    // `if (!shape) return fail("no shape declared")` and refuses a missing
    // currency the same way, so a surface without both is one this lane can
    // fetch and can never read. Measured on the live artifact 2026-08-11: 35
    // surfaces had a revenue block and 5 had a shape and a currency, so 30
    // fetches an hour went out against other people's APIs to produce a
    // failure row apiece.
    const out = eligibleRevenueSurfaces(ARTIFACT);
    assert.deepEqual(
      out.map((s) => s.id),
      ["a"],
    );
  });

  test("a shape with no currency is not eligible either", () => {
    assert.deepEqual(
      eligibleRevenueSurfaces({
        surfaces: [
          { surface_id: "x", netuid: 1, revenue: { shape: "scalar" } },
          { surface_id: "y", netuid: 2, revenue: { currency: "USD" } },
        ],
      }),
      [],
      "extractRevenue needs both, so eligibility needs both",
    );
  });

  test("an UNKNOWN shape is still eligible, deliberately", () => {
    // extractRevenue validates the vocabulary and fails with `unknown shape`,
    // which writes a failure row naming the surface -- and a typo in the
    // registry is exactly what that row should surface. Filtering it here
    // would make a registry error look like a surface never meant to be
    // probed.
    assert.deepEqual(
      eligibleRevenueSurfaces({
        surfaces: [
          {
            surface_id: "typo",
            netuid: 1,
            url: "https://example/typo",
            revenue: { shape: "scalarr", currency: "USD" },
          },
        ],
      }).map((s) => s.id),
      ["typo"],
    );
  });

  test("probe.enabled is restored rather than assumed away", () => {
    // The artifact's own build filter keeps only probe-enabled, public-safe
    // surfaces, so the projection drops the flag — but probeEligibility still
    // checks it, and a surface arriving without it would be silently skipped.
    assert.equal(eligibleRevenueSurfaces(ARTIFACT)[0].probe?.enabled, true);
  });

  test("junk yields no surfaces rather than throwing", () => {
    for (const input of [null, undefined, {}, { surfaces: "no" }]) {
      assert.deepEqual(eligibleRevenueSurfaces(input as never), []);
    }
  });

  test("the build filter that makes probe.enabled implicit still holds", async () => {
    // Pinning the assumption above to its source. If this filter ever stops
    // requiring probe.enabled, the lane starts fetching surfaces nobody
    // authorised it to touch.
    const build = await fs.readFile(
      path.join(repoRoot, "scripts/build-artifacts.ts"),
      "utf8",
    );
    const filter = build.slice(
      build.indexOf("const operationalSurfaces = surfaces"),
      build.indexOf("const operationalSurfaces = surfaces") + 400,
    );
    assert.match(filter, /surface\.probe\?\.enabled/);
    assert.match(filter, /surface\.public_safe/);
  });
});

describe("loadRevenueObservations", () => {
  test("groups a flat result set into per-surface series", async () => {
    const db = readingDb([
      {
        surface_id: "a",
        period: "2026-08-10",
        amount: 100,
        response_hash: "h1",
        observed_at: 1786320000000,
      },
      {
        surface_id: "a",
        period: "2026-08-09",
        amount: 90,
        response_hash: "h1",
        observed_at: 1786320000000,
      },
      {
        surface_id: "b",
        period: "2026-07",
        amount: 5,
        response_hash: null,
        observed_at: 1786320000000,
      },
    ]);
    const map = await loadRevenueObservations(db, 64);
    assert.ok(map);
    assert.equal(map.get("a")?.length, 2);
    assert.equal(map.get("b")?.length, 1);
    assert.equal(map.get("a")?.[0].amount_usd, 100);
    assert.equal(map.get("b")?.[0].response_hash, null);
    assert.match(map.get("a")?.[0].observed_at ?? "", /^2026-/);
  });

  test("reads only USD rows", async () => {
    // The declaration schema permits TAO and ALPHA; converting either needs the
    // tao-usd rate at each observation's own instant. validate:revenue-provenance
    // refuses to let one be declared, and this is the other half of that pair.
    const db = readingDb([]);
    let captured = "";
    const spy = {
      prepare(sql: string) {
        captured = sql;
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    } as unknown as RevenueStoreDb;
    await loadRevenueObservations(spy, 64);
    assert.match(captured, /currency = 'USD'/);
    assert.ok(await loadRevenueObservations(db, 64));
  });

  test("a read failure is null, an empty store is an empty map", async () => {
    // Not the same fact: nothing observed yet is a real answer, a failed read
    // is not, and collapsing them would make a broken store look like a subnet
    // that earns nothing.
    assert.equal(
      await loadRevenueObservations(readingDb(null, true), 64),
      null,
    );
    assert.equal(await loadRevenueObservations(null, 64), null);
    const empty = await loadRevenueObservations(readingDb([]), 64);
    assert.ok(empty);
    assert.equal(empty.size, 0);
  });

  test("a network-wide read binds no netuid", async () => {
    let bound: unknown[] = ["unset"];
    const spy = {
      prepare() {
        return {
          bind: (...v: unknown[]) => {
            bound = v;
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    } as unknown as RevenueStoreDb;
    await loadRevenueObservations(spy, null);
    assert.deepEqual(bound, []);
  });

  test("an unparseable amount is dropped rather than written as NaN", async () => {
    const map = await loadRevenueObservations(
      readingDb([{ surface_id: "a", period: "p", amount: "not a number" }]),
      64,
    );
    assert.ok(map);
    assert.equal(map.size, 0);
  });
});

describe("the lane end to end", () => {
  test("probes, hashes, and persists in one pass", async () => {
    const { db, calls } = recordingDb();
    const r = await runRevenueProbeLane(
      [
        {
          id: "sn-64-chutes-daily-revenue-summary",
          netuid: 64,
          url: "https://example/daily",
          auth_required: false,
          probe: { enabled: true },
          revenue: {
            role: "external-revenue",
            provenance: "probe-derived",
            currency: "USD",
            grain: "daily",
            shape: "flat-array",
            fields: { date: "date", amount: "total_revenue" },
          },
        },
      ],
      db,
      {
        fetchPayload: async () => ({
          payload: [{ date: "2026-08-08", total_revenue: 11668 }],
          raw: '[{"date":"2026-08-08","total_revenue":11668}]',
        }),
        hash: sha256Hex,
        now: () => 1786320000000,
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.written, 1);
    assert.equal(calls.length, 1);
    // The raw response is hashed and kept: an operator can withdraw a feed once
    // an unflattering ratio is published, and a withdrawal that leaves nothing
    // behind is indistinguishable from a subnet that never had revenue.
    const hash = calls[0].values[7] as string;
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test("an ineligible surface is skipped, not fetched", async () => {
    const { db } = recordingDb();
    let fetched = 0;
    const r = await runRevenueProbeLane(
      [
        {
          id: "gated",
          netuid: 93,
          url: "https://example/gated",
          auth_required: true,
          probe: { enabled: true },
          revenue: { role: "external-revenue", provenance: "probe-derived" },
        },
      ],
      db,
      {
        fetchPayload: async () => {
          fetched += 1;
          return { payload: {}, raw: "{}" };
        },
        hash: sha256Hex,
        now: () => 1786320000000,
      },
    );
    assert.equal(fetched, 0, "an auth-gated surface must never be fetched");
    assert.equal(r.skipped, 1);
  });
});

describe("fetchRevenuePayload", () => {
  test("a non-2xx throws rather than handing an error body to the extractor", async () => {
    // An operator returning 500 with a JSON error body must not have that body
    // read for a field name.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"boom","total":9}', {
        status: 500,
      })) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchRevenuePayload("https://example/x"),
        /HTTP 500/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns the parsed body and the exact text it came from", async () => {
    const original = globalThis.fetch;
    const raw = '{"total":42}';
    globalThis.fetch = (async () => new Response(raw)) as typeof fetch;
    try {
      const out = await fetchRevenuePayload("https://example/x");
      assert.deepEqual(out.payload, { total: 42 });
      assert.equal(
        out.raw,
        raw,
        "the hash must cover the bytes, not a re-serialisation",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("degenerate input", () => {
  // Every branch below is a "the row was not what we expected" path. They are
  // the ones that matter most in a lane reading third-party payloads: a shape
  // this code cannot handle must produce a missing figure, never a wrong one.

  test("a non-Error throw still yields a readable verdict", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              run: async () => {
                throw "connection lost";
              },
            };
          },
        };
      },
    } as unknown as RevenueStoreDb;
    const r = await persistRevenueProbe(db, {
      observations: [OBSERVATION],
      failures: [],
      skipped: [],
    });
    assert.match(r.reason ?? "", /write_failed: connection lost/);
  });

  test("a surface missing its id or url becomes empty strings, not undefined", () => {
    // probeEligibility and the store both read these as strings; "undefined"
    // rendered into a surface_id would be written to the table as a real key.
    const [surface] = eligibleRevenueSurfaces({
      surfaces: [
        {
          netuid: 7,
          revenue: {
            role: "external-revenue",
            shape: "scalar",
            currency: "USD",
          },
        },
      ],
    });
    assert.equal(surface.id, "");
    assert.equal(surface.url, "");
  });

  test("a result set with no rows key reads as empty, not as a throw", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
    } as unknown as RevenueStoreDb;
    const map = await loadRevenueObservations(db, 64);
    assert.ok(map);
    assert.equal(map.size, 0);
  });

  test("a row missing its surface_id is dropped rather than keyed on empty", async () => {
    const map = await loadRevenueObservations(
      readingDb([{ period: "2026-08-10", amount: 5 }]),
      64,
    );
    assert.ok(map);
    assert.equal(map.size, 0, "an unkeyed figure belongs to no surface");
  });

  test("a row missing its period keeps the figure under an empty period", async () => {
    // Not dropped: the amount is real and the surface is known. An empty period
    // sorts last and cannot satisfy a window, so it degrades to "not observed"
    // rather than being silently counted as today.
    const map = await loadRevenueObservations(
      readingDb([{ surface_id: "a", amount: 5 }]),
      64,
    );
    assert.ok(map);
    assert.equal(map.get("a")?.[0].period, "");
  });

  test("an unusable observed_at is null rather than an epoch date", async () => {
    // 0 and negatives are not instants, and `new Date(0).toISOString()` would
    // stamp 1970 onto a figure read this week. 1e16 is past the Date range
    // (max +/-8.64e15), so it clears the finite check and still yields an
    // Invalid Date — a stamp in seconds-times-a-typo lands exactly there.
    for (const observed_at of [0, -1, "not a number", null, 1e16]) {
      const map = await loadRevenueObservations(
        readingDb([{ surface_id: "a", period: "p", amount: 1, observed_at }]),
        64,
      );
      assert.equal(
        map?.get("a")?.[0].observed_at,
        null,
        `observed_at=${JSON.stringify(observed_at)}`,
      );
    }
  });

  test("a real millisecond stamp becomes an ISO instant", async () => {
    const map = await loadRevenueObservations(
      readingDb([
        { surface_id: "a", period: "p", amount: 1, observed_at: 1786320000000 },
      ]),
      64,
    );
    assert.equal(map?.get("a")?.[0].observed_at, "2026-08-10T00:00:00.000Z");
  });
});

describe("the wiring — a correct lane nobody calls is the defect", () => {
  test("the cron expression is registered as a trigger", async () => {
    // Code and trigger are deployed by different mechanisms: Workers Builds
    // ships the former and not the latter. A constant with no matching entry
    // here never fires, which looks exactly like the state before this lane.
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

  test("handleScheduled routes the cron to the PRODUCER and returns its verdict", async () => {
    // The branch itself, not just its presence in the source. A dispatch that
    // matches no branch returns undefined and the tick reports success having
    // done nothing — the same shape of silence this lane was built to end.
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        {} as unknown as Parameters<typeof handleScheduled>[1],
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.enqueued, 0);
    // The cron is a PRODUCER now (#10715): it enqueues one message per eligible
    // surface and does no probing. With no queue binding it declines rather
    // than pretending -- and the binding is reported before the empty list,
    // because a missing binding is a config error and "no eligible surfaces"
    // would send someone to the registry instead.
    assert.equal(result.reason, "no_queue_binding");
  });

  test("both tables are declared Neon sole-store in every config", async () => {
    // producerStore and readStore both refuse a table they were not told
    // about, so an undeclared table yields no db — and the lane would write
    // nothing, silently, which is the failure it was built to end.
    for (const file of [
      "wrangler.jsonc",
      "wrangler.data.jsonc",
      "wrangler.registry.jsonc",
    ]) {
      const text = await fs.readFile(path.join(repoRoot, file), "utf8");
      const list =
        /"NEON_SOLE_STORE_TABLES":\s*"([^"]*)"/.exec(text)?.[1] ?? "";
      const tables = list.split(",");
      for (const table of REVENUE_OBSERVATION_TABLES) {
        assert.ok(
          tables.includes(table),
          `${table} missing from NEON_SOLE_STORE_TABLES in ${file}`,
        );
      }
    }
  });

  test("the migration that creates both tables exists", async () => {
    const sql = await fs.readFile(
      path.join(repoRoot, "migrations/neon/0016_revenue_observations.sql"),
      "utf8",
    );
    for (const table of REVENUE_OBSERVATION_TABLES) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
  });
});

describe("the queue lane (#10715)", () => {
  const surface = {
    id: "sn-64-chutes-daily-revenue-summary",
    netuid: 64,
    url: "https://api.chutes.ai/invoices/summary",
    auth_required: false,
    probe: { enabled: true },
    revenue: {
      role: "external-revenue",
      provenance: "probe-derived",
      currency: "USD",
      grain: "daily",
      shape: "flat-array",
      fields: { date: "date", amount: "total_revenue" },
    },
  };

  function queue(sent: Array<Array<{ body: unknown }>>, fail = false) {
    return {
      async sendBatch(messages: Array<{ body: { surface_id: string } }>) {
        if (fail) throw new Error("queue unavailable");
        sent.push(messages);
      },
    };
  }

  test("enqueues every eligible surface", async () => {
    const sent: Array<Array<{ body: unknown }>> = [];
    const out = await enqueueRevenueProbes(queue(sent), ["a", "b"]);
    assert.deepEqual(out, { ok: true, enqueued: 2 });
  });

  test("splits at the sendBatch cap", async () => {
    const sent: Array<Array<{ body: unknown }>> = [];
    const many = Array.from({ length: SEND_BATCH_MAX + 3 }, (_, i) => `s${i}`);
    await enqueueRevenueProbes(queue(sent), many);
    assert.deepEqual(
      sent.map((b) => b.length),
      [SEND_BATCH_MAX, 3],
    );
  });

  test("an EMPTY eligible set is not a success", async () => {
    // This lane is why the rule exists: it shipped with no caller and reported
    // null for 129 subnets for two months (#10566).
    assert.equal(
      (await enqueueRevenueProbes(queue([]), [])).reason,
      "no_eligible_surfaces",
    );
    assert.equal(
      (await enqueueRevenueProbes(null, ["a"])).reason,
      "no_queue_binding",
    );
  });

  test("a send failure reports what actually went out", async () => {
    const out = await enqueueRevenueProbes(queue([], true), ["a"]);
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /queue unavailable/);
  });

  test("a thrown non-Error still names the failure", async () => {
    const out = await enqueueRevenueProbes(
      {
        async sendBatch() {
          throw "a bare string";
        },
      },
      ["a"],
    );
    assert.match(String(out.reason), /a bare string/);
  });

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
    prepare: () => ({
      bind: () => ({
        run: async () => undefined,
        all: async () => ({ results: [] }),
      }),
      all: async () => ({ results: [] }),
    }),
  });

  const deps = (over: Record<string, unknown> = {}) => ({
    fetchPayload: async () => ({
      payload: [{ date: "2026-08-08", total_revenue: 11668 }],
      raw: '[{"date":"2026-08-08","total_revenue":11668}]',
    }),
    hash: sha256Hex,
    now: () => 1_786_320_000_000,
    surfaceFor: () => surface,
    ...over,
  });

  test("probes one surface per message and ACKS it on success", async () => {
    const m = message({ surface_id: surface.id });
    const out = await handleRevenueProbeBatch([m], store(), deps() as never);
    assert.deepEqual(out, { done: 1, retried: 0, dropped: 0 });
    assert.equal(m.calls.acked, 1);
  });

  test("RETRIES when the write fails, because an unwritten probe did not happen", async () => {
    const m = message({ surface_id: surface.id });
    const out = await handleRevenueProbeBatch([m], null, deps() as never);
    assert.equal(out.retried, 1);
    assert.equal(m.calls.retried, 1);
  });

  test("re-reads the eligible set at DELIVERY", async () => {
    // A message that waited must not probe a surface the registry has since
    // withdrawn.
    let askedFor: string | null = null;
    await handleRevenueProbeBatch(
      [message({ surface_id: "sn-x" })],
      store(),
      deps({
        surfaceFor: (id: string) => {
          askedFor = id;
          return null;
        },
      }) as never,
    );
    assert.equal(askedFor, "sn-x");
  });

  test("a WITHDRAWN surface is acked, not retried", async () => {
    // Re-delivering will not bring it back.
    const m = message({ surface_id: "gone" });
    const out = await handleRevenueProbeBatch(
      [m],
      store(),
      deps({ surfaceFor: () => null }) as never,
    );
    assert.deepEqual(out, { done: 0, retried: 0, dropped: 1 });
    assert.equal(m.calls.acked, 1);
  });

  test("ACKS a malformed body rather than looping it to the dead letter", async () => {
    const bad = [message({ surface_id: 42 }), message({}), message(null)];
    const out = await handleRevenueProbeBatch(bad, store(), deps() as never);
    assert.equal(out.dropped, 3);
    for (const m of bad) assert.equal(m.calls.acked, 1);
  });

  test("RETRIES when the probe throws, without taking out the batch", async () => {
    // One poison message costs one subject, never the others delivered with it.
    const bad = message({ surface_id: surface.id });
    const good = message({ surface_id: surface.id });
    let first = true;
    const out = await handleRevenueProbeBatch(
      [bad, good],
      store(),
      deps({
        fetchPayload: async () => {
          if (first) {
            first = false;
            throw new Error("feed exploded");
          }
          return {
            payload: [{ date: "2026-08-08", total_revenue: 11668 }],
            raw: '[{"date":"2026-08-08","total_revenue":11668}]',
          };
        },
      }) as never,
    );
    assert.equal(out.retried, 1);
    assert.equal(out.done, 1);
  });

  test("the dead-letter queue is registered as a lane", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "src/dead-letter.ts"),
      "utf8",
    );
    assert.match(source, /"revenue-probes-dlq"/);
  });

  test("both queues are declared, with a dead letter", async () => {
    const wrangler = await fs.readFile(
      path.join(repoRoot, "wrangler.jsonc"),
      "utf8",
    );
    assert.match(wrangler, /"binding": "REVENUE_PROBES"/);
    assert.match(wrangler, /"dead_letter_queue": "revenue-probes-dlq"/);
  });

  test("the consumer branches on the queue name", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /batch\.queue === REVENUE_PROBE_QUEUE/);
  });
});

describe("the revenue queue, through the Worker's own handler", () => {
  const OPERATIONAL = "/metagraph/operational-surfaces.json";
  const SURFACE = {
    surface_id: "sn-64-x",
    netuid: 64,
    url: "https://api.example/revenue",
    auth_required: false,
    revenue: {
      role: "external-revenue",
      provenance: "probe-derived",
      // shape + currency are what make a surface EXTRACTABLE, and therefore
      // what make it eligible (#10783). This fixture carried currency and no
      // shape, which is a surface the lane could fetch and never read.
      shape: "scalar",
      fields: { amount: "revenue_usd" },
      currency: "USD",
      grain: "daily",
    },
  };

  function env(payload: unknown, extra: Record<string, unknown> = {}) {
    const hit = (p: string) => p === OPERATIONAL && payload != null;
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

  test("the cron producer enqueues every eligible surface", async () => {
    const sent: string[] = [];
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        env(
          { surfaces: [SURFACE] },
          {
            REVENUE_PROBES: {
              async sendBatch(
                messages: Array<{ body: { surface_id: string } }>,
              ) {
                for (const m of messages) sent.push(m.body.surface_id);
              },
            },
          },
        ) as never,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.deepEqual(result, { lane: "revenue-probe", ok: true, enqueued: 1 });
    assert.deepEqual(sent, ["sn-64-x"]);
  });

  test("a probe batch is routed to the probe consumer, not the webhook path", async () => {
    // Both queues bind to one `queue()` export. Without the branch this message
    // would be handed to the webhook deliverer.
    let acked = 0;
    const batch = {
      queue: "revenue-probes",
      messages: [
        {
          body: { surface_id: "sn-64-x" },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    };
    await assert.doesNotReject(() =>
      worker.queue!(
        batch as never,
        env({ surfaces: [SURFACE] }) as never,
        { waitUntil: () => {} } as never,
      ),
    );
  });

  test("no operational-surfaces artifact enqueues nothing, and says so", async () => {
    // The artifact-absent branch: an unreadable artifact must not read as "no
    // surfaces are eligible", which is the same claim by a different route.
    const result = laneResult(
      await handleScheduled(
        { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
        env(null, {
          REVENUE_PROBES: { async sendBatch() {} },
        }) as never,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_eligible_surfaces");
  });

  test("an unreadable artifact at DELIVERY acks rather than retrying forever", async () => {
    // The consumer's artifact-absent branch. Every surface reads as withdrawn,
    // which is acked -- retrying would burn the budget re-reading an artifact
    // that is not there.
    let acked = 0;
    const batch = {
      queue: "revenue-probes",
      messages: [
        {
          body: { surface_id: "sn-64-x" },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    };
    await worker.queue!(
      batch as never,
      env(null) as never,
      { waitUntil: () => {} } as never,
    );
    assert.equal(acked, 1);
  });

  test("a withdrawn surface is acked at the Worker level too", async () => {
    let acked = 0;
    const batch = {
      queue: "revenue-probes",
      messages: [
        {
          body: { surface_id: "gone" },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    };
    await worker.queue!(
      batch as never,
      env({ surfaces: [] }) as never,
      { waitUntil: () => {} } as never,
    );
    assert.equal(acked, 1);
  });
});
