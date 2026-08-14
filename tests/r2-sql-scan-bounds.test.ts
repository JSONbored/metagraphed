// The scan-bounds rule (#11132), tested on synthetic sources.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  INTERPOLATED_PREDICATES,
  UNBOUNDED_BY_DESIGN,
  findUnbounded,
} from "../scripts/validate-r2-sql-scan-bounds.ts";

const call = (q: string) => `const rows = await r2SqlQuery(env, \`${q}\`);`;

describe("r2-sql scan bounds", () => {
  test("a scattered key with no bound is a finding", () => {
    const found = findUnbounded(
      "src/x.ts",
      call("SELECT amount_tao FROM chain.account_events WHERE hotkey = '5A'"),
    );
    assert.equal(found.length, 1);
  });

  test("a time bound clears it", () => {
    const found = findUnbounded(
      "src/x.ts",
      call(
        "SELECT amount_tao FROM chain.account_events WHERE hotkey = '5A' AND observed_at >= 1",
      ),
    );
    assert.deepEqual(found, []);
  });

  test("block_number counts as a bound too", () => {
    assert.deepEqual(
      findUnbounded(
        "src/x.ts",
        call(
          "SELECT x FROM chain.extrinsics WHERE coldkey = '5A' AND block_number > 10",
        ),
      ),
      [],
    );
  });

  test("a query with no scattered key is not a finding", () => {
    assert.deepEqual(
      findUnbounded(
        "src/x.ts",
        call("SELECT count(*) FROM chain.blocks WHERE netuid = 1"),
      ),
      [],
    );
  });

  test("a Neon query is not a lakehouse read", () => {
    // The first sweep of this reported 62 findings by matching `?`-placeholder
    // Neon queries and prose. Only chain.* / chain_testnet.* is in scope.
    assert.deepEqual(
      findUnbounded(
        "src/x.ts",
        `await sql.unsafe("SELECT x FROM neurons WHERE hotkey = ?", [h]);`,
      ),
      [],
    );
  });

  test("testnet reads are in scope", () => {
    const found = findUnbounded(
      "src/x.ts",
      call("SELECT x FROM chain_testnet.account_events WHERE hotkey = '5A'"),
    );
    assert.equal(found.length, 1);
  });

  test("the whole call is matched, not a truncated window", () => {
    // The bound can sit far past a 300-char cut -- that truncation is what
    // produced the bogus 62.
    const padding = "-- ".repeat(120);
    assert.deepEqual(
      findUnbounded(
        "src/x.ts",
        call(
          `SELECT a, b, c FROM chain.account_events WHERE hotkey = '5A' ${padding} AND observed_at >= 1`,
        ),
      ),
      [],
    );
  });

  test("every exemption carries a measured cost", () => {
    assert.ok(Object.keys(UNBOUNDED_BY_DESIGN).length > 0);
    for (const [file, why] of Object.entries(UNBOUNDED_BY_DESIGN)) {
      assert.match(why, /measured|MB|rows/, `${file} exemption states no cost`);
    }
  });
});

describe("the two ways this gate went blind (#11131)", () => {
  const unbounded =
    "const rows = await r2SqlQuery<AccountEventsRow>(env,\n" +
    "  `SELECT a FROM chain.account_events WHERE hotkey = 'x' LIMIT 50`);";

  test("A GENERIC TYPE ARGUMENT NO LONGER HIDES THE CALL", () => {
    // The pattern required `r2SqlQuery(env,` literally, so every
    // `r2SqlQuery<Row>(env, ...)` was invisible -- 16 of the 61 call sites in
    // src/, including all four unbounded reads on chain.account_events. The
    // gate reported "every reader satisfies this today" while the route it was
    // protecting timed out in production.
    assert.equal(findUnbounded("src/new.ts", unbounded).length, 1);
  });

  test("the same call with a bound still passes", () => {
    assert.deepEqual(
      findUnbounded(
        "src/new.ts",
        unbounded.replace("LIMIT 50", "AND block_number >= 1 LIMIT 50"),
      ),
      [],
    );
  });

  const interpolated =
    "where.push(`hotkey = 'x'`);\n" +
    "const rows = await r2SqlQuery<Row>(env,\n" +
    '  `SELECT a FROM chain.account_events WHERE ${where.join(" AND ")} LIMIT 50`);';

  test("AN INTERPOLATED WHERE IS REPORTED, NOT SILENTLY SKIPPED", () => {
    // The predicate does not exist until runtime, so neither the scattered key
    // nor the bound is in the source. Before this the call fell out of scope
    // entirely -- and that is how essentially every cold-tier reader is
    // written. Unreadable is not the same as safe.
    const found = findUnbounded("src/unlisted.ts", interpolated);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.unreadable, true);
  });

  test("a listed file is covered by its runtime SQL-capture test instead", () => {
    for (const file of Object.keys(INTERPOLATED_PREDICATES)) {
      assert.deepEqual(findUnbounded(file, interpolated), [], file);
    }
  });

  test("every INTERPOLATED_PREDICATES entry NAMES the test that covers it", () => {
    // An exemption that just says "trust me" is the thing this gate exists to
    // stop, one level up. Each entry has to point at where the real SQL is
    // captured and asserted.
    for (const [file, why] of Object.entries(INTERPOLATED_PREDICATES)) {
      assert.match(why, /tests\/[\w.-]+\.test\.ts/, file);
    }
  });

  test("a netuid-filtered interpolated WHERE stays quiet", () => {
    // #11133's own lesson: its first sweep reported 62 findings of which 3 were
    // real, and a gate that cries wolf gets muted. Only a file that builds a
    // SCATTERED predicate somewhere can be hiding one in an interpolated WHERE.
    const netuid =
      "where.push(`netuid = 1`);\n" +
      "const rows = await r2SqlQuery(env,\n" +
      '  `SELECT a FROM chain.subnet_identity_history WHERE ${where.join(" AND ")} LIMIT 50`);';
    assert.deepEqual(findUnbounded("src/history.ts", netuid), []);
  });
});
