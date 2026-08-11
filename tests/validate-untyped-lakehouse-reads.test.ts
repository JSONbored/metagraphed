// The lakehouse read ratchet (scripts/validate-untyped-lakehouse-reads.ts).
//
// The property worth testing is the COUNTING, not the ceiling: a matcher that
// silently undercounts lowers a ratchet nobody earned, which is the direction
// the Neon counter's own header calls out as the worst way to be wrong.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  countLakehouseReads,
  countUntypedLakehouseReads,
  MAX_UNTYPED_LAKEHOUSE_READS,
} from "../scripts/validate-untyped-lakehouse-reads.ts";

describe("countUntypedLakehouseReads", () => {
  test("counts a call with no type argument", () => {
    assert.equal(countUntypedLakehouseReads("await r2SqlQuery(env, sql);"), 1);
  });

  test("does NOT count one that names its row", () => {
    assert.equal(
      countUntypedLakehouseReads("await r2SqlQuery<BlocksRow>(env, sql);"),
      0,
    );
  });

  test("counts across the line break prettier introduces", () => {
    // The Neon counter was wrong this way once: a single-line matcher read 92
    // of 105 and reported the difference as an improvement.
    assert.equal(
      countUntypedLakehouseReads("await r2SqlQuery\n  (env, sql);"),
      1,
    );
  });

  test("prose about the gate is not a read", () => {
    // This file and the script both write `r2SqlQuery(` in comments. Counting
    // those would make the gate its own regression.
    assert.equal(
      countUntypedLakehouseReads("// call r2SqlQuery( here\n * r2SqlQuery("),
      0,
    );
  });

  test("an import or a `typeof` position is not a read", () => {
    assert.equal(
      countUntypedLakehouseReads(
        'import { r2SqlQuery } from "./r2-sql.ts";\nlet f: typeof r2SqlQuery;',
      ),
      0,
    );
  });

  test("the total counts typed and untyped alike", () => {
    const src = "r2SqlQuery(a);\nr2SqlQuery<BlocksRow>(b);";
    assert.equal(countLakehouseReads(src), 2);
    assert.equal(countUntypedLakehouseReads(src), 1);
  });

  test("the ceiling is a number, so it can fall to zero", () => {
    // Annotated rather than left as a literal precisely so the "none left"
    // branch stays reachable code.
    assert.equal(typeof MAX_UNTYPED_LAKEHOUSE_READS, "number");
    assert.ok(MAX_UNTYPED_LAKEHOUSE_READS >= 0);
  });
});
