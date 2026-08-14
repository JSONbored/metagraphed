// The scan-bounds rule (#11132), tested on synthetic sources.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
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
