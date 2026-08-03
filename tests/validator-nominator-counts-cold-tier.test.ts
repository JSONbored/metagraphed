// nominator_count, served from the lakehouse (#9146).
//
// The field was null on EVERY validator on /api/v1/validators and
// /api/v1/validators/{hotkey} (verified live 2026-08-03): it comes from the
// validator_nominator_counts side table, which never followed the neurons
// family onto D1, so the D1 twins hand both builders a degraded value and every
// card serves "unknown".
//
// The properties worth pinning are the ones a plausible implementation gets
// wrong. The read must be a group-wise MAX -- the Iceberg mirror has no
// PRIMARY KEY (hotkey) to lean on, so an equality read would let an arbitrary
// capture generation win. A partial batch must decline the WHOLE read, or which
// validators get a count depends on where they fell in the chunking. And the
// overlay must fill only what is missing and never write a miss to null, so
// "unknown" and "confirmed zero" stay distinguishable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  enrichValidatorNominatorCounts,
  loadValidatorNominatorCountsColdTier,
  NOMINATOR_COUNT_HOTKEY_CHUNK,
} from "../src/validator-nominator-counts-cold-tier.ts";
import {
  overlayNominatorCounts,
  validatorHotkeysNeedingCount,
} from "../src/validator-nominator-summary.ts";
import { GLOBAL_VALIDATOR_LIMIT_MAX } from "../src/route-limits.ts";

type Row = Record<string, unknown>;

// Valid SS58 by safeSs58Literal's rule (base58, 47-49 chars): Alice's address
// with its last two characters swapped for a per-index pair, so a test can mint
// as many distinct, guard-passing hotkeys as it needs.
const SS58_PREFIX = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKut";
const BASE58 = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const hotkeyAt = (i: number) =>
  `${SS58_PREFIX}${BASE58[Math.floor(i / BASE58.length) % BASE58.length]}${BASE58[i % BASE58.length]}`;

const HK_A = hotkeyAt(0);
const HK_B = hotkeyAt(1);
const HK_C = hotkeyAt(2);

/** Records every statement and answers each from a hotkey -> count table. */
function fakeEngine(
  counts: Record<string, number> = { [HK_A]: 42, [HK_B]: 0 },
  { fail }: { fail?: (sql: string) => boolean } = {},
) {
  const seen: string[] = [];
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (fail?.(sql)) return null;
    return Object.entries(counts)
      .filter(([hotkey]) => sql.includes(`'${hotkey}'`))
      .map(([hotkey, nominator_count]) => ({ hotkey, nominator_count }));
  };
  return { query, seen };
}

const leaderboard = (validators: Row[]): Row => ({
  sort: "total_stake_tao",
  validator_count: validators.length,
  validators,
});

describe("loadValidatorNominatorCountsColdTier", () => {
  test("reads the newest capture per hotkey, not an arbitrary one", async () => {
    // The Iceberg mirror carries no PRIMARY KEY (hotkey), so more than one
    // capture generation can exist for a hotkey. Without the group-wise MAX the
    // formatter's Map.set would keep whichever row the engine returned last.
    const engine = fakeEngine();
    const counts = await loadValidatorNominatorCountsColdTier(
      {} as never,
      [HK_A, HK_B],
      { query: engine.query as never },
    );
    assert.deepEqual(
      [...counts!],
      [
        [HK_A, 42],
        [HK_B, 0],
      ],
    );
    assert.equal(engine.seen.length, 1);
    const sql = engine.seen[0];
    assert.match(
      sql,
      /ROW_NUMBER\(\) OVER \(PARTITION BY hotkey ORDER BY captured_at DESC\)/,
    );
    assert.match(sql, /WHERE rn = 1/);
    assert.match(sql, /FROM chain\.validator_nominator_counts/);
    assert.ok(sql.includes(`'${HK_A}', '${HK_B}'`));
  });

  test("chunks a page too wide for one statement and unions the answers", async () => {
    // The validators directory fetches ?limit=2000, which as one inlined IN
    // list is a ~100KB statement.
    const hotkeys = Array.from(
      { length: NOMINATOR_COUNT_HOTKEY_CHUNK + 1 },
      (_, i) => hotkeyAt(i),
    );
    const last = hotkeys[hotkeys.length - 1];
    const engine = fakeEngine({ [HK_A]: 42, [last]: 7 });
    const counts = await loadValidatorNominatorCountsColdTier(
      {} as never,
      hotkeys,
      { query: engine.query as never },
    );
    assert.equal(engine.seen.length, 2);
    assert.equal(counts!.get(HK_A), 42);
    assert.equal(counts!.get(last), 7, "the tail chunk must be read too");
  });

  test("one failed chunk declines the whole read", async () => {
    // Keeping the chunks that answered would make the presence of a count
    // depend on where a hotkey happened to land in the batching.
    const hotkeys = Array.from(
      { length: NOMINATOR_COUNT_HOTKEY_CHUNK + 1 },
      (_, i) => hotkeyAt(i),
    );
    const engine = fakeEngine(
      { [HK_A]: 42 },
      { fail: (sql) => sql.includes(`'${hotkeys[hotkeys.length - 1]}'`) },
    );
    assert.equal(
      await loadValidatorNominatorCountsColdTier({} as never, hotkeys, {
        query: engine.query as never,
      }),
      null,
    );
  });

  test("drops an unusable hotkey but still answers for the rest", async () => {
    const engine = fakeEngine({ [HK_A]: 42 });
    const counts = await loadValidatorNominatorCountsColdTier(
      {} as never,
      ["", "not-an-address", "'; DROP TABLE x --", null, HK_A],
      { query: engine.query as never },
    );
    assert.equal(counts!.get(HK_A), 42);
    assert.equal(counts!.size, 1);
    assert.ok(!engine.seen[0].includes("DROP TABLE"));
  });

  test("no usable hotkey resolves to an empty map without touching the engine", async () => {
    const engine = fakeEngine();
    for (const hotkeys of [[], ["nope"], "not-an-array" as never]) {
      const counts = await loadValidatorNominatorCountsColdTier(
        {} as never,
        hotkeys,
        { query: engine.query as never },
      );
      assert.equal(counts!.size, 0);
    }
    assert.equal(engine.seen.length, 0, "an empty IN list is not a query");
  });

  test("deduplicates a hotkey repeated in the page", async () => {
    const engine = fakeEngine({ [HK_A]: 42 });
    await loadValidatorNominatorCountsColdTier(
      {} as never,
      [HK_A, HK_A, HK_A],
      { query: engine.query as never },
    );
    assert.equal(
      engine.seen[0].split(`'${HK_A}'`).length - 1,
      1,
      "the same hotkey must be inlined once",
    );
  });

  test("caps the fan-out at the widest page the route can serve", async () => {
    const hotkeys = Array.from(
      { length: GLOBAL_VALIDATOR_LIMIT_MAX + 5 },
      (_, i) => hotkeyAt(i),
    );
    const engine = fakeEngine({});
    await loadValidatorNominatorCountsColdTier({} as never, hotkeys, {
      query: engine.query as never,
    });
    assert.equal(
      engine.seen.length,
      Math.ceil(GLOBAL_VALIDATOR_LIMIT_MAX / NOMINATOR_COUNT_HOTKEY_CHUNK),
    );
  });

  test("rows pass through the shared formatter's own validation", async () => {
    // A count that is negative, fractional or absent is not a count -- rejected
    // by nominatorCountsByHotkey rather than re-checked here.
    const engine = fakeEngine({ [HK_A]: -1, [HK_B]: 1.5, [HK_C]: 3 });
    const counts = await loadValidatorNominatorCountsColdTier(
      {} as never,
      [HK_A, HK_B, HK_C],
      { query: engine.query as never },
    );
    assert.deepEqual([...counts!], [[HK_C, 3]]);
  });
});

describe("validatorHotkeysNeedingCount", () => {
  test("collects the leaderboard's unanswered hotkeys", () => {
    assert.deepEqual(
      validatorHotkeysNeedingCount(
        leaderboard([
          { hotkey: HK_A, nominator_count: null },
          { hotkey: HK_B, nominator_count: null },
        ]),
      ),
      [HK_A, HK_B],
    );
  });

  test("collects a single validator's detail shape", () => {
    assert.deepEqual(
      validatorHotkeysNeedingCount({ hotkey: HK_A, nominator_count: null }),
      [HK_A],
    );
  });

  test("skips an entry that already has a count", () => {
    // Keeps the overlay additive: a tier that answered for real costs no read
    // and can never have a fresher value replaced by a staler one.
    assert.deepEqual(
      validatorHotkeysNeedingCount(
        leaderboard([
          { hotkey: HK_A, nominator_count: 9 },
          { hotkey: HK_B, nominator_count: 0 },
          { hotkey: HK_C, nominator_count: null },
        ]),
      ),
      [HK_C],
    );
  });

  test("skips an entry with no usable hotkey", () => {
    assert.deepEqual(
      validatorHotkeysNeedingCount(
        leaderboard([
          { hotkey: "", nominator_count: null },
          { nominator_count: null },
        ]),
      ),
      [],
    );
  });

  test("is empty for a body it does not recognise", () => {
    for (const data of [null, undefined, "nope", 42, {}, { validators: 7 }]) {
      assert.deepEqual(validatorHotkeysNeedingCount(data), []);
    }
  });
});

describe("overlayNominatorCounts", () => {
  test("fills the leaderboard's entries by hotkey", () => {
    const data = overlayNominatorCounts(
      leaderboard([
        { hotkey: HK_A, nominator_count: null },
        { hotkey: HK_B, nominator_count: null },
      ]),
      new Map([
        [HK_A, 42],
        [HK_B, 0],
      ]),
    );
    assert.equal((data.validators as Row[])[0].nominator_count, 42);
    assert.equal(
      (data.validators as Row[])[1].nominator_count,
      0,
      "zero is an answer, not an absence",
    );
    assert.equal(data.validator_count, 2, "the envelope is preserved");
  });

  test("fills a single validator's detail", () => {
    assert.equal(
      overlayNominatorCounts(
        { hotkey: HK_A, nominator_count: null },
        new Map([[HK_A, 42]]),
      ).nominator_count,
      42,
    );
  });

  test("leaves a hotkey the map missed exactly as it was", () => {
    // Writing a miss to null would erase the difference between "we have no
    // record" and "this validator has no nominators".
    const data = overlayNominatorCounts(
      leaderboard([
        { hotkey: HK_A, nominator_count: null },
        { hotkey: HK_B, nominator_count: 7 },
      ]),
      new Map([[HK_C, 1]]),
    );
    assert.equal((data.validators as Row[])[0].nominator_count, null);
    assert.equal((data.validators as Row[])[1].nominator_count, 7);
  });

  test("skips an entry with no usable hotkey", () => {
    const data = overlayNominatorCounts(
      leaderboard([{ nominator_count: null }]),
      new Map([[HK_A, 42]]),
    );
    assert.equal((data.validators as Row[])[0].nominator_count, null);
  });

  test("returns the payload untouched when there is nothing to apply", () => {
    const empty = leaderboard([{ hotkey: HK_A, nominator_count: null }]);
    assert.equal(overlayNominatorCounts(empty, new Map()), empty);
    for (const data of [null, undefined, "nope", { validators: 7 }]) {
      assert.equal(overlayNominatorCounts(data, new Map([[HK_A, 1]])), data);
    }
  });
});

describe("enrichValidatorNominatorCounts", () => {
  test("fills an already-built leaderboard from the lakehouse", async () => {
    const engine = fakeEngine();
    const data = await enrichValidatorNominatorCounts(
      {} as never,
      leaderboard([
        { hotkey: HK_A, nominator_count: null },
        { hotkey: HK_B, nominator_count: null },
      ]),
      {
        load: (env, hotkeys) =>
          loadValidatorNominatorCountsColdTier(env, hotkeys, {
            query: engine.query as never,
          }),
      },
    );
    assert.deepEqual(
      (data.validators as Row[]).map((v) => v.nominator_count),
      [42, 0],
    );
  });

  test("a declining lakehouse leaves the payload exactly as it was", async () => {
    const data = leaderboard([{ hotkey: HK_A, nominator_count: null }]);
    assert.equal(
      await enrichValidatorNominatorCounts({} as never, data, {
        load: async () => null,
      }),
      data,
      "the caller's payload is the floor, never a regression",
    );
  });

  test("asks for nothing when there is nothing to fill", async () => {
    let called = 0;
    const load = async () => {
      called += 1;
      return new Map<string, number>();
    };
    for (const data of [
      leaderboard([{ hotkey: HK_A, nominator_count: 9 }]),
      leaderboard([]),
      null,
    ]) {
      assert.equal(
        await enrichValidatorNominatorCounts({} as never, data, { load }),
        data,
      );
    }
    assert.equal(called, 0);
  });
});

describe("every validator surface fills the field through the one loader", () => {
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("REST, MCP and GraphQL all call enrichValidatorNominatorCounts", () => {
    for (const [surface, path] of Object.entries(sources)) {
      // Both the leaderboard and the single-validator card, per surface --
      // wiring only one is how the two disagree about the same hotkey.
      const callSites =
        readFileSync(path, "utf8").split("enrichValidatorNominatorCounts(")
          .length - 1;
      assert.ok(
        callSites >= 2,
        `${surface} (${path}) would keep serving nominator_count: null (found ${callSites} call site(s), needs the leaderboard and the detail)`,
      );
    }
  });
});
