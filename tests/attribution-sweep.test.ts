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
import {
  fetchSweepText,
  handleScheduled,
  sweepableSubnets,
} from "../workers/api.ts";
import {
  ATTRIBUTION_SWEEP_CRON,
  REVENUE_PROBE_CRON,
} from "../workers/config.ts";
import { ATTRIBUTION_SWEEP_TABLES } from "../src/read-store-tables.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
import {
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_BYTES,
  SWEEP_MAX_SOURCES,
  loadSweptAt,
  nextToSweep,
  runAttributionSweepTick,
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
        prepare() {
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
          prepare() {
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

describe("the lane", () => {
  const record = (netuid: number, urls: string[] = []) => ({
    netuid,
    record: {
      netuid,
      surfaces: urls.map((url) => ({ kind: "website", url })),
    },
  });

  function store(rows: unknown[] = [], onWrite?: (sql: string) => void) {
    return {
      prepare(sql: string) {
        onWrite?.(sql);
        return {
          bind: () => ({
            run: async () => undefined,
            all: async () => ({ results: rows }),
          }),
          all: async () => ({ results: rows }),
        };
      },
    };
  }

  test("sweeps the LEAST RECENTLY swept first, never-swept before that", () => {
    const order = nextToSweep(
      [1, 2, 3, 4],
      new Map([
        [1, 5_000],
        [2, 1_000],
        [4, 9_000],
      ]),
      3,
    );
    // 3 has never been swept: the only state where we have said nothing at all.
    assert.deepEqual(order, [3, 2, 1]);
  });

  test("breaks ties by netuid so a tick is deterministic", () => {
    assert.deepEqual(nextToSweep([9, 4, 7], new Map(), 2), [4, 7]);
  });

  test("a failed staleness read re-sweeps rather than skipping", async () => {
    // Erring toward re-reading is the safe direction: the cost is requests,
    // and the alternative is a subnet that silently never gets looked at.
    const swept = await loadSweptAt({
      prepare() {
        throw new Error("store unavailable");
      },
    });
    assert.equal(swept.size, 0);
  });

  test("reads back every subnet's last sweep", async () => {
    const swept = await loadSweptAt(
      store([
        { netuid: 1, swept_at: NOW },
        { netuid: 2, swept_at: "not a number" },
      ]),
    );
    assert.deepEqual([...swept.entries()], [[1, NOW]]);
  });

  test("a tick sweeps a bounded slice and counts the verdicts", async () => {
    const out = await runAttributionSweepTick(
      store(),
      [
        record(1, ["https://a.example/"]),
        record(2, ["https://b.example/"]),
        record(3),
      ],
      {
        fetchText: async (url) =>
          url === "https://a.example/" ? `treasury ${REAL}` : null,
        now: () => NOW,
        batch: 3,
      },
    );
    assert.equal(out.swept, 3);
    assert.equal(out.candidates, 1);
    assert.deepEqual(out.verdicts, {
      "candidates-found": 1,
      unreachable: 1,
      "no-sources": 1,
      "none-published": 0,
    });
    assert.equal(out.ok, true);
  });

  test("an EMPTY batch is not a success", async () => {
    // A lane reporting ok while sweeping nothing is indistinguishable from one
    // that swept and found nothing -- the confusion that let the revenue probe
    // sit dead for two months (#10566).
    const out = await runAttributionSweepTick(store(), [], {
      fetchText: async () => null,
      now: () => NOW,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no_subnets_to_sweep");
    assert.equal(out.swept, 0);
  });

  test("a write failure fails the tick rather than being swallowed", async () => {
    const out = await runAttributionSweepTick(null, [record(1)], {
      fetchText: async () => null,
      now: () => NOW,
    });
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /no_store_binding/);
    assert.equal(out.swept, 1, "it still swept -- only the write failed");
  });

  test("the batch defaults to the declared size", async () => {
    const subnets = Array.from({ length: SWEEP_BATCH_SIZE + 4 }, (_, i) =>
      record(i + 1),
    );
    const out = await runAttributionSweepTick(store(), subnets, {
      fetchText: async () => null,
      now: () => NOW,
    });
    assert.equal(out.swept, SWEEP_BATCH_SIZE);
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
      wrangler.includes(`"${ATTRIBUTION_SWEEP_CRON}"`),
      `${ATTRIBUTION_SWEEP_CRON} is not in wrangler.jsonc triggers.crons`,
    );
  });

  test("the cron does not collide with another lane", () => {
    // Dispatch keys on the literal expression, so two lanes sharing one string
    // means the first branch wins and the second silently never runs.
    assert.equal(ATTRIBUTION_SWEEP_CRON, "56 * * * *");
    assert.notEqual(ATTRIBUTION_SWEEP_CRON, REVENUE_PROBE_CRON);
  });

  test("dispatch and its label both know the cron", async () => {
    const api = await fs.readFile(
      path.join(repoRoot, "workers/api.ts"),
      "utf8",
    );
    assert.match(api, /if \(cron === ATTRIBUTION_SWEEP_CRON\) \{/);
    assert.match(api, /return "attribution-sweep"/);
  });

  test("handleScheduled routes the cron to the lane and returns its verdict", async () => {
    const result = (await handleScheduled(
      { cron: ATTRIBUTION_SWEEP_CRON } as unknown as ScheduledController,
      {} as unknown as Parameters<typeof handleScheduled>[1],
      { waitUntil: () => {} } as unknown as ExecutionContext,
    )) as { ok: boolean; swept: number; reason?: string };
    // No artifact and no store: the lane must decline rather than report a
    // pass with nothing swept.
    assert.equal(result.ok, false);
    assert.equal(result.swept, 0);
    assert.equal(result.reason, "no_subnets_to_sweep");
  });

  test("both tables are declared Neon sole-store in every config", async () => {
    // producerStore and readStore both refuse a table they were not told
    // about, so an undeclared table yields no db -- and the lane would write
    // nowhere while reporting a binding problem it cannot explain.
    for (const config of [
      "wrangler.jsonc",
      "wrangler.data.jsonc",
      "wrangler.registry.jsonc",
    ]) {
      const text = await fs.readFile(path.join(repoRoot, config), "utf8");
      for (const table of ATTRIBUTION_SWEEP_TABLES) {
        assert.ok(
          text.includes(table),
          `${table} is not declared sole-store in ${config}`,
        );
      }
    }
  });

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
  function artifactEnv(payload: unknown) {
    const path = "/metagraph/subnets.json";
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return pathname === path && payload != null
            ? Response.json(payload as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          return pathname === path && payload != null
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

  test("reads the subnet list from the served artifact, skipping root", async () => {
    // Root is emission-ineligible, so there is no owner cut to account for and
    // nothing this sweep is looking for on its behalf.
    const out = await sweepableSubnets(
      artifactEnv({
        subnets: [
          { netuid: 0, surfaces: [] },
          { netuid: 64, surfaces: [] },
          { netuid: "nope" },
          null,
        ],
      }) as never,
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
    assert.deepEqual(
      await sweepableSubnets(artifactEnv({ subnets: "not a list" }) as never),
      [],
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
        prepare() {
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

  test("a driver returning no results key reads as unswept", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ all: async () => ({}) }),
        all: async () => ({}),
      }),
    };
    assert.equal(await loadSweepRecord(db, 64), null);
    assert.equal((await loadSweptAt(db)).size, 0);
  });

  test("a row with no verdict reads as null, not as a finding", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [{ swept_at: NOW }] }) }),
        all: async () => ({ results: [{ swept_at: NOW }] }),
      }),
    };
    const out = await loadSweepRecord(db, 64);
    assert.equal(out?.verdict, null);
  });
});
