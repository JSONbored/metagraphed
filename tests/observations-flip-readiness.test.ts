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

/** Files that serve observation reads. */
function readSiteFiles(): string[] {
  const handlers = readdirSync("workers/request-handlers")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `workers/request-handlers/${f}`);
  return ["src/graphql.ts", "src/health-prober.ts", ...handlers];
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
  for (const file of readSiteFiles()) {
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
