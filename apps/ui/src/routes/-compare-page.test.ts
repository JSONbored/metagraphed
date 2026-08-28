import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(fileURLToPath(new URL("./-compare-page.tsx", import.meta.url)), "utf8");

describe("compare selection handoff", () => {
  it("distinguishes zero, one, and comparison-ready selections in the page copy", () => {
    expect(page).toContain('"Pick two subnets to compare."');
    expect(page).toContain("`SN${subnets[0]} selected. Add one more to compare.`");
    expect(page).toContain('"Pick two validators to compare."');
    expect(page).toContain('"One validator selected. Add one more to compare."');
  });

  it("gives both incomplete states a direct path to the relevant directory", () => {
    expect(page).toContain('action={{ label: "Browse subnets", href: "/subnets" }}');
    expect(page).toContain('action={{ label: "Browse validators", href: "/validators" }}');
    expect(page).toContain(
      'title={netuids.length === 1 ? "Add one more subnet" : "Pick two subnets"}',
    );
    expect(page).toContain(
      'title={hotkeys.length === 1 ? "Add one more validator" : "Pick two validators"}',
    );
  });
});
