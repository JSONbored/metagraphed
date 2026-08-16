// The gate that keeps `as unknown as` at zero (#11339).
//
// It exists because that spelling does not announce itself. A single `as B`
// still fails when `A` and `B` do not overlap; routing through `unknown` erases
// the relationship entirely, so the cast never fails and the population only
// grows. This repo reached 325 of them, four hiding live defects.
//
// Most of these pin what it must NOT report, because the failure mode for a
// gate like this is a false positive on prose -- `as never` appears in comments
// in this codebase ("reads as never having reported") and a grep-based version
// would fail on the sentence describing the problem it fixes.
import { describe, expect, it } from "vitest";
import {
  areaOf,
  BUDGETS,
  findDoubleAssertions,
} from "../scripts/validate-double-assertions.ts";

const scan = (source: string) => findDoubleAssertions("probe.ts", source);

describe("findDoubleAssertions", () => {
  it("catches the single-line double hop", () => {
    const found = scan("const a = value as unknown as string;");
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("unknown-hop");
  });

  it("CATCHES IT WRAPPED ACROSS LINES -- the reason this is an AST gate", () => {
    // The formatter wraps a cast the moment its type argument is long, and a
    // gate reading source as text goes blind on exactly the sites most worth
    // catching. Four of the last casts in this repo were found only here.
    expect(
      scan(`const a = value as unknown as
        | Record<string, unknown>
        | undefined;`),
    ).toHaveLength(1);
  });

  it("catches `as never`, which is one step worse", () => {
    // `as never` makes a value assignable to EVERYTHING, so it also silences
    // the arguments beside it at the same call.
    const found = scan("fn(rows[0] as never, ref);");
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("never");
  });

  it("IGNORES PROSE -- `as never` in a comment is not a cast", () => {
    expect(
      scan("// a lane that reported nothing reads as never having reported\n"),
    ).toEqual([]);
  });

  it("ignores `as never` inside a string literal", () => {
    expect(scan('const s = "reported as never having run";')).toEqual([]);
  });

  it("A PLAIN `as T` IS NOT A VIOLATION", () => {
    // The rule is about the spelling that switches checking OFF. A single
    // assertion still fails when the two types do not overlap, and
    // validate-boundary-casts.ts owns the separate question of whether one over
    // an untrusted read should have been a parse.
    expect(scan("const a = value as string;")).toEqual([]);
    expect(scan("const a = value as Record<string, unknown>;")).toEqual([]);
  });

  it("a lone `as unknown` is an ADMISSION, not a claim", () => {
    // Casting TO unknown forces every field to be narrowed before use, which is
    // the thing this gate wants. Only the second hop is the problem.
    expect(scan("const a = value as unknown;")).toEqual([]);
  });

  it("reports the line, so the failure names the site", () => {
    const found = scan("const a = 1;\nconst b = a as unknown as string;");
    expect(found[0]!.line).toBe(2);
  });

  it("finds every occurrence, not just the first", () => {
    expect(
      scan("const a = x as unknown as A;\nconst b = y as unknown as B;"),
    ).toHaveLength(2);
  });
});

describe("areaOf", () => {
  it("attributes a finding to its top-level directory", () => {
    expect(areaOf("scripts/lib/worker-env.ts")).toBe("scripts");
    expect(areaOf("src/r2-sql.ts")).toBe("src");
  });

  it("does not confuse a nested directory with a top-level one", () => {
    // `packages/client/scripts/x.ts` counts against packages, not scripts --
    // otherwise a workspace could quietly spend another area's budget.
    expect(areaOf("packages/client/scripts/x.ts")).toBe("packages");
  });

  it("handles a repo-root file without inventing a directory", () => {
    expect(areaOf("vitest.config.ts")).toBe("vitest.config.ts");
  });
});

describe("BUDGETS", () => {
  it("holds the four swept areas at zero", () => {
    // Not a restatement of the constant: these four were driven to zero by
    // #11339/#11361/#11368 and a nonzero entry here is a silent regression
    // budget, which is the thing this gate exists to prevent.
    for (const area of ["src", "workers", "schemas-src", "packages"]) {
      expect(BUDGETS[area]).toBe(0);
    }
  });

  it("covers every area a cast could hide in outside tests", () => {
    expect(Object.keys(BUDGETS).sort()).toEqual([
      "packages",
      "schemas-src",
      "scripts",
      "src",
      "workers",
    ]);
  });
});
