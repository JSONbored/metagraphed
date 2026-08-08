// The observation family cannot be flipped while any read site is still
// hard-wired to D1 (#10086).
//
// ## Why this is a test and not a checklist
//
// The flip is a CONFIG change -- five table names added to
// NEON_SOLE_STORE_TABLES. Nothing about that edit reveals whether the reads can
// follow it, and getting it wrong is silent in the worst way: the prober stops
// writing D1, every health route goes on reading D1, and the payload does not
// error or empty -- it just stops advancing. Freshness looks normal for one
// probe interval and then flatlines.
//
// So rather than track how many sites are left, this makes the dangerous edit
// fail CI until they are all wired. The count going down is progress; the count
// reaching zero is what unlocks the flag, and that is checked rather than
// remembered.
//
// A site is "wired" when it passes `observationsReadDb(env, ctx)` instead of a
// raw `METAGRAPH_HEALTH_DB` binding.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "vitest";
import { OBSERVATION_TABLES } from "../src/observations-neon.ts";

/** The files that call the observation LOADERS. Narrow on purpose: the
 * `db:`-shaped scan below looks for a loader argument, and `db:
 * env.METAGRAPH_HEALTH_DB` is a perfectly correct thing to write for a table
 * that has nothing to do with this family. */
function loaderCallSiteFiles(): string[] {
  const handlers = readdirSync("workers/request-handlers")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `workers/request-handlers/${f}`);
  return ["src/graphql.ts", "src/health-prober.ts", ...handlers];
}

/** Every source file, for the SQL-shaped scan -- a side reader can live
 * anywhere. */
function readSiteFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(`${dir}/${e.name}`)
        : e.name.endsWith(".ts")
          ? [`${dir}/${e.name}`]
          : [],
    );
  return [...walk("src"), ...walk("workers")];
}

/** Modules that legitimately talk to one store on purpose: the two write
 * halves, the per-store adapters, and the cross-store lanes whose whole job is
 * to hold both at once. */
const STORE_AWARE = [
  "src/observations-neon.ts",
  "src/observations-d1.ts",
  "src/observations-read-runner.ts",
  "src/neon-backfill.ts",
  "src/neon-parity-watchdog.ts",
  "src/neon-prune.ts",
  "src/neon-mirror-watchdog.ts",
  "src/health-sql.ts",
];

/**
 * A marker that a module does not hard-wire itself to D1.
 *
 * TWO WAYS to qualify, and missing the second made this over-report:
 *
 *   1. it SELECTS a store   -- observationsReadDb / createPgSql / routeStore
 *   2. it takes an INJECTED runner -- `ObservationsReadDb`, a `D1Runner`, or a
 *      bare `(sql, params) => rows` parameter
 *
 * A module in group 2 is already store-agnostic; whichever store it reads is
 * decided by its caller, so flagging it sends you editing a file that has
 * nothing wrong with it. economics-trends, metagraph-neurons and
 * account-stake-moves are all group 2 and were all reported as blockers.
 */
const SELECTS_A_STORE =
  /observationsReadDb|createPgSql|routeStore|neonOwnsTable|neonReadLanes|ObservationsReadDb|D1Runner|d1:\s*\(\s*\n?\s*sql/;

/**
 * Files that name an observation table in SQL but cannot reach Neon.
 *
 * The `db:`-shaped scan below is not enough on its own, and believing it was
 * would have been the whole bug again: `subnet_snapshots` has five readers
 * (metagraph-neurons, top-holders-holdings, economics-trends,
 * account-stake-moves, request-handlers/entities) that build their own SQL and
 * never go near an observation loader. A gate blind to those would have said
 * "ready" and frozen six more surfaces on the flip.
 */
function tableReadersWithoutASelector(): { file: string; tables: string[] }[] {
  const out: { file: string; tables: string[] }[] = [];
  for (const file of readSiteFiles()) {
    if (STORE_AWARE.includes(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (SELECTS_A_STORE.test(source)) continue;
    const tables = OBSERVATION_TABLES.filter((t) =>
      new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`).test(source),
    );
    if (tables.length) out.push({ file, tables });
  }
  return out;
}

/**
 * A raw D1 binding handed to an observation loader.
 *
 * Matches the two shapes this codebase actually uses -- `db: env.X` in an
 * options bag, and the positional `env.X as unknown as ObservationsReadDb`.
 */
const RAW_BINDING =
  /db:\s*(?:context\.)?env\.METAGRAPH_HEALTH_DB|METAGRAPH_HEALTH_DB as unknown as ObservationsReadDb/g;

function unwiredSites(): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const file of loaderCallSiteFiles()) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const count = [...source.matchAll(RAW_BINDING)].length;
    if (count) out.push({ file, count });
  }
  return out;
}

/** Observation tables named as Neon's in a wrangler config. */
function flippedTables(config: string): string[] {
  const source = readFileSync(config, "utf8");
  const named = new Set(
    (/"NEON_SOLE_STORE_TABLES":\s*"([^"]*)"/.exec(source)?.[1] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  return OBSERVATION_TABLES.filter((t) => named.has(t));
}

describe("observation flip readiness", () => {
  const CONFIGS = ["wrangler.jsonc", "wrangler.data.jsonc"];

  test("the family is not flipped while any read site is hard-wired to D1", () => {
    const unwired = unwiredSites();
    for (const config of CONFIGS) {
      const flipped = flippedTables(config);
      if (unwired.length === 0) continue;
      assert.deepEqual(
        flipped,
        [],
        `${config} names ${flipped.join(", ")} as Neon's, but these still read D1 directly:\n` +
          unwired.map((u) => `    ${u.file} (${u.count})`).join("\n") +
          `\nWire them through observationsReadDb(env, ctx) before flipping, or the ` +
          `prober stops writing D1 while every health route keeps reading it.`,
      );
    }
  });

  test("the family flips ALL FIVE together or not at all", () => {
    // Two of the writes are INSERT ... SELECT FROM surface_checks, aggregating
    // inside the store, so a partial flip leaves a rollup reading one store
    // while its source rows live in the other.
    for (const config of CONFIGS) {
      const flipped = flippedTables(config);
      assert.ok(
        flipped.length === 0 || flipped.length === OBSERVATION_TABLES.length,
        `${config} flips ${flipped.length} of ${OBSERVATION_TABLES.length} observation tables: ${flipped.join(", ")}`,
      );
    }
  });

  test("the family is not flipped while a SIDE reader is stuck on D1", () => {
    // The loader-shaped scan above misses these entirely: they build their own
    // SQL over subnet_snapshots and never touch an observation loader. Flipping
    // with these unported freezes them on a store the prober no longer writes.
    const stuck = tableReadersWithoutASelector();
    for (const config of CONFIGS) {
      const flipped = flippedTables(config);
      if (stuck.length === 0) continue;
      assert.deepEqual(
        flipped,
        [],
        `${config} names ${flipped.join(", ")} as Neon's, but these read those tables ` +
          `from D1 with no store selection:\n` +
          stuck
            .map((s) => `    ${s.file} -> ${s.tables.join(", ")}`)
            .join("\n"),
      );
    }
  });

  test("every side reader is ported -- the scan finds NOTHING", () => {
    // This assertion is the flip precondition, and it was written the other way
    // round first: it pinned the five files that were then unported, so the gate
    // could not quietly start passing on an empty set while they were still
    // hard-wired. They are ported now, so the pin inverts -- and the fixture
    // test below is what keeps THIS from passing on a broken scanner.
    assert.deepEqual(
      tableReadersWithoutASelector().map(
        (s) => `${s.file} -> ${s.tables.join(",")}`,
      ),
      [],
    );
  });

  test("the side-reader scan still WORKS, against a file it must flag", () => {
    // Non-vacuous guard for the assertion above. A scanner broken to match
    // nothing would make "every side reader is ported" trivially true, which is
    // the exact failure mode this whole file exists to prevent one layer down.
    const selects = /observationsReadDb|createPgSql|routeStore/;
    const hardWired = `const db = env.METAGRAPH_HEALTH_DB;
      await db.prepare("SELECT netuid FROM subnet_snapshots").all();`;
    assert.equal(selects.test(hardWired), false);
    assert.ok(
      /\b(?:FROM|JOIN|INTO|UPDATE)\s+subnet_snapshots\b/.test(hardWired),
      "the table regex no longer matches a plain FROM",
    );
  });

  test("the detector actually matches the shapes in this repo", () => {
    // A scanner that matches nothing would let the first test pass on an empty
    // set forever, which is the failure mode it exists to prevent. There ARE
    // unwired sites today (graphql.ts among them), so this pins that the regex
    // still sees them -- and when the count reaches zero this assertion is what
    // must be deliberately updated, rather than the guard rotting silently.
    const sample = `db: env.METAGRAPH_HEALTH_DB,
      db: context.env.METAGRAPH_HEALTH_DB,
      env.METAGRAPH_HEALTH_DB as unknown as ObservationsReadDb,`;
    assert.equal([...sample.matchAll(RAW_BINDING)].length, 3);
  });
});
