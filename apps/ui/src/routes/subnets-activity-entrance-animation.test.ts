import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8528: the subnet-activity table's entrance animation lives in
// -subnets-netuid-page.tsx, which only renders inside the full app shell +
// router + suspense data. Per this repo's convention (see api-source-context.test.tsx),
// the wiring is asserted on source; the falsifiable new-vs-seen logic is unit-tested
// directly in lib/metagraphed/new-row-tracker.test.ts.

const source = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);

describe("subnet-activity entrance animation wiring (#8528)", () => {
  it("animates new rows with the existing mg-fade-in utility, not a new system", () => {
    expect(source).toContain("mg-fade-in");
    // no bespoke keyframe / animation library introduced in this route
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/animate-\[/);
  });

  it("drives new-vs-existing off the shared mount-time tracker", () => {
    expect(source).toContain("diffNewRows");
    expect(source).toContain("newKeys");
  });

  it("uses no per-row timers for the animation (pure CSS on mount, #8365)", () => {
    // The animation must not schedule anything. (setInterval appears nowhere;
    // any setTimeout in this file would be unrelated, but there are none.)
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/setTimeout\s*\(/);
  });

  it("only fades top-level rows, never nested expanded-group children", () => {
    expect(source).toContain('isNew && !nested && "mg-fade-in"');
  });
});

// #8817: the expand/collapse open-set must be keyed by the content-derived
// activityGroupKey, not by array index -- a prepended live event shifts every
// group's index, so an index-keyed set collapses the open row and springs a
// different one open.
describe("subnet-activity expand/collapse identity wiring (#8817)", () => {
  it("keys the open-set by string identity, never by array index", () => {
    expect(source).not.toMatch(/useState<ReadonlySet<number>>/);
    expect(source).toMatch(/useState<ReadonlySet<string>>/);
  });

  it("does not read expand state by index", () => {
    expect(source).not.toContain("expandedGroups.has(i)");
  });

  it("derives group identity from the single activityGroupKey helper", () => {
    expect(source).toContain("activityGroupKey");
    // The row key and the state key come from the same helper -- no second,
    // index-suffixed identity string beside it.
    expect(source).not.toMatch(/\$\{group\.kind\}-\$\{group\.events\[0\]!\.block_number\}/);
  });
});
