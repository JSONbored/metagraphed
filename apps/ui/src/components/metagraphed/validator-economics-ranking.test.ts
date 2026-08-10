// The cross-subnet validator-economics ranking (#10300).
//
// A leaderboard that silently drops the rows it could not rank reports a subset
// as the whole. The route returns those rows in `excluded` WITH a reason, and
// the reasons are the information: thirty subnets excluded for one cause is a
// different story from thirty excluded for thirty causes.
import { describe, expect, it } from "vitest";
import { groupExclusions } from "./validator-economics-ranking";
import type { ExcludedSubnet } from "@/lib/metagraphed/types";

const ex = (netuid: number, reason: string | null): ExcludedSubnet => ({ netuid, reason });

describe("grouping exclusions by reason", () => {
  it("collects the subnets that share a reason", () => {
    const out = groupExclusions([
      ex(1, "no validators"),
      ex(2, "no validators"),
      ex(3, "read failed"),
    ]);
    expect(out).toEqual([
      ["no validators", [1, 2]],
      ["read failed", [3]],
    ]);
  });

  it("puts the largest group first", () => {
    const out = groupExclusions([ex(1, "rare"), ex(2, "common"), ex(3, "common")]);
    expect(out[0][0]).toBe("common");
  });

  it("a MISSING reason becomes an explicit bucket rather than being dropped", () => {
    // Dropping the ones that did not say why would understate the count the
    // heading already published — the panel would claim N excluded and then
    // account for fewer than N.
    const out = groupExclusions([ex(1, null), ex(2, "no validators")]);
    const total = out.reduce((n, [, list]) => n + list.length, 0);
    expect(total).toBe(2);
    expect(out.map(([reason]) => reason)).toContain("reason unstated");
  });

  it("nothing excluded is an empty list", () => {
    expect(groupExclusions([])).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const input = [ex(1, "a"), ex(2, "b")];
    groupExclusions(input);
    expect(input).toHaveLength(2);
  });
});
