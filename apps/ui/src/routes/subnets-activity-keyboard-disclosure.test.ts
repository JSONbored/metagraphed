import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8821: ActivityGroupRow lives in -subnets-netuid-page.tsx, which only renders
// inside the full app shell + router + suspense data. Per this repo's convention
// (see subnets-activity-entrance-animation.test.ts), assert the wiring on source.

const source = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);

describe("subnet ActivityGroupRow keyboard disclosure (#8821)", () => {
  it("does not put aria-expanded on a bare <tr> (invalid on implicit row role)", () => {
    // The grouped summary row used to carry aria-expanded={expanded} on <tr>.
    // Require that attribute off any tr that has no role= override.
    expect(source).not.toMatch(/<tr[\s\S]{0,200}aria-expanded=\{expanded\}/);
  });

  it("exposes a real button type=button bound to onToggle with aria-expanded and aria-label", () => {
    expect(source).toMatch(/<button\s+type="button"/);
    expect(source).toContain("aria-expanded={expanded}");
    expect(source).toContain("aria-controls={controlsId}");
    expect(source).toMatch(/aria-label=\{/);
    expect(source).toContain("onToggle()");
    // Button click must not double-fire with the row's onClick.
    expect(source).toContain("e.stopPropagation()");
  });

  it("keeps row onClick for mouse users and leaves the single-event fast path alone", () => {
    expect(source).toContain("onClick={onToggle}");
    expect(source).toContain("group.events.length === 1");
    expect(source).toContain("<ActivityEventRow ev={group.events[0]!} isNew={isNew} />");
  });
});
