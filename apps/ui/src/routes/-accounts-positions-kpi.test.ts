import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8818: the Positions figure must not fabricate "0" from a query that has
// not answered. Zero positions and an unresolved read are opposite facts
// about an account, and `?? 0` renders them identically.
//
// #11614 rebuilt the page, so the specific machinery this pinned -- an
// `AsyncPanel`, a `statPhase` ternary, a `StatUnavailable` tile -- is gone.
// The property is not: every hero figure derived from the positions read
// resolves to null, and renders as a dash, until that read lands.
//
// Source assertions rather than a render: the page composes TanStack
// Router/Query context a node-environment test cannot stand up.
const source = readFileSync(
  fileURLToPath(new URL("./-accounts-ss58-page.tsx", import.meta.url)),
  "utf8",
);

describe("#8818 the /accounts figures never fabricate a zero", () => {
  it("derives every positions figure from one nullable read", () => {
    expect(source).toContain("const held = positions.data?.data.positions ?? null;");
    expect(source).toMatch(/const staked = held \? held\.reduce/);
    expect(source).toMatch(/const subnetCount = held \?/);
    expect(source).toContain("const positionCount = positions.data?.data.position_count ?? null;");
  });

  it("renders a dash for an unresolved count, not a number", () => {
    // #11693 merged the two cells into one "Positions / subnets", so the guard
    // is now a single expression over both reads -- the PROPERTY is unchanged
    // and is what this asserts: neither count reaches the strip without having
    // been tested against null first.
    expect(source).toMatch(/positionCount === null \|\| subnetCount === null\s*\?\s*"—"/);
    expect(source).toContain('label: "Positions / subnets"');
  });

  it("never coerces a positions field to zero", () => {
    for (const fabricated of [
      "position_count ?? 0",
      "positions ?? []",
      "portfolio?.position_count ?? 0",
    ]) {
      expect(source, `${fabricated} fabricates a figure`).not.toContain(fabricated);
    }
  });

  it("states the scan cap rather than printing a capped count as a total", () => {
    // Above the cap the summary describes the scanned prefix; printing it as
    // a total understates a whale by an unknown amount.
    expect(source).toMatch(/scanCapped\s*\? `> \$\{formatNumber\(EVENT_SCAN_CAP\)\}`/);
  });

  it("does not suspend the whole account route on the history aggregate", () => {
    expect(source).toContain("const summaryQuery = useQuery({ ...accountQuery(ss58), retry: 0 });");
    expect(source).not.toContain("useSuspenseQuery(accountQuery(ss58))");
    expect(source).toContain("loading: summaryQuery.isPending");
    expect(source).toContain('summary === null\n          ? "—"');
  });
});
