// The untyped-read ratchet's matchers (#10311).
//
// The gate itself reads the tree and calls process.exit, so what is unit-tested
// is the two derivations it decides on: how a read declares the escape hatch,
// and whether a runner has quietly reintroduced a default row type.
//
// The second one is the half that makes the count mean anything. With a default
// back in place every escape hatch could be deleted and the reads would still
// compile -- untyped, uncounted, and green. That is exactly the state #10261
// left behind, so it is checked rather than trusted.

import { describe, expect, it } from "vitest";
import {
  countUntypedReads,
  runnersWithDefaultRow,
} from "../scripts/validate-untyped-db-reads.ts";

describe("what counts as an untyped read", () => {
  it("counts a tagged-template read", () => {
    expect(
      countUntypedReads(
        "const rows = await sql<Record<string, unknown>>`SELECT 1`;",
      ),
    ).toBe(1);
  });

  it("counts an unsafe read", () => {
    expect(
      countUntypedReads(
        "const rows = await sql.unsafe<Record<string, unknown>>(text, values);",
      ),
    ).toBe(1);
  });

  // The runner is also reached under an alias in two handlers, and through D1's
  // prepared statements. An identifier-keyed matcher missed the D1 one; keying
  // on the type argument found it.
  it("counts an aliased runner and a D1 prepared read", () => {
    expect(
      countUntypedReads(
        "await historySql<Record<string, unknown>>`SELECT 1`;\n" +
          "await db.prepare(SQL).all<Record<string, unknown>>();",
      ),
    ).toBe(2);
  });

  // Prettier splits long reads across lines at 16 sites in data-api.ts. A
  // single-line matcher counted 92 of 106 and called the difference an
  // improvement -- a ratchet wrong in the direction that invites lowering the
  // ceiling to a number nobody earned.
  it("counts a read whose type argument prettier split across lines", () => {
    expect(
      countUntypedReads(
        "await sql<\n  Record<string, unknown>\n>`DELETE FROM t WHERE id = ${id}`;",
      ),
    ).toBe(1);
  });

  it("does not count a read that names a real row type", () => {
    expect(
      countUntypedReads("const rows = await sql<NeuronRow>`SELECT 1`;"),
    ).toBe(0);
  });

  // Prose about this gate names the pattern it counts, so the gate's own
  // docblock read as a regression of one until comment lines were dropped.
  it("does not count a mention inside a comment", () => {
    expect(
      countUntypedReads(
        "/**\n * A read that cannot type itself writes `sql<Record<string, unknown>>`.\n */\n" +
          "// see also sql.unsafe<Record<string, unknown>>(text)\n",
      ),
    ).toBe(0);
  });

  // Stripping to end-of-line instead would eat whatever followed a `https://`
  // in a string -- an undercount, which is the direction that quietly lowers a
  // ratchet nobody earned.
  it("still counts a read on a line holding a URL string", () => {
    expect(
      countUntypedReads(
        'const u = "https://api.metagraph.sh"; await sql<Record<string, unknown>>`SELECT 1`;',
      ),
    ).toBe(1);
  });

  // `Record<string, unknown>` is all over this tree as an ordinary annotation.
  // Only the ones in type-argument position on a call or tag are reads.
  it("does not count an ordinary Record annotation", () => {
    expect(
      countUntypedReads(
        "let row: Record<string, unknown> = {};\n" +
          "function f(x: Record<string, unknown>) { return x; }",
      ),
    ).toBe(0);
  });
});

describe("the runners must not default their row type", () => {
  it("flags a runner that reintroduced the default", () => {
    expect(
      runnersWithDefaultRow([
        { file: "src/pg-sql.ts", source: "  <Row = Record<string, unknown>>(" },
        { file: "workers/data-api.ts", source: "  <Row>(" },
      ]),
    ).toEqual(["src/pg-sql.ts"]);
  });

  it("passes when neither runner defaults", () => {
    expect(
      runnersWithDefaultRow([
        { file: "src/pg-sql.ts", source: "  <Row>(" },
        { file: "workers/data-api.ts", source: "  <Row>(" },
      ]),
    ).toEqual([]);
  });
});
