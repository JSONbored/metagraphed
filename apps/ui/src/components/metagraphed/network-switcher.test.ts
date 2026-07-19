import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6422: the "Advanced · API origin" override input had only a placeholder — not
// an accessible name — so a screen reader announced the field as unlabelled.
// SearchInput (table-controls.tsx) already sets aria-label for exactly this
// reason. Verified in a browser: getByRole("textbox", { name: "Custom API
// origin" }) resolves after this change.
//
// Source assertion (this component renders inside the app-shell header + needs a
// router; the suite is node-environment).
const source = readFileSync(
  fileURLToPath(new URL("./network-switcher.tsx", import.meta.url)),
  "utf8",
);

describe("NetworkSwitcher custom API-origin input has an accessible name (#6422)", () => {
  it("gives the origin input an aria-label", () => {
    // The input is the one carrying the localhost placeholder; its opening tag
    // must now also carry a non-empty aria-label.
    const start = source.indexOf('placeholder="http://localhost:8787"');
    expect(start).toBeGreaterThan(-1);
    const tagOpen = source.lastIndexOf("<input", start);
    const tagClose = source.indexOf("/>", start);
    const inputTag = source.slice(tagOpen, tagClose);
    expect(inputTag).toMatch(/aria-label="[^"]+"/);
    expect(inputTag).toContain('aria-label="Custom API origin"');
  });
});

// #6902: the trigger button's label span + chevron rendered unconditionally,
// pushing the shared header 10px past the viewport at 375px width (confirmed
// via document.body.scrollWidth vs window.innerWidth on the live site). Fixed
// by collapsing to icon+dot only below `sm`, so the network stays reachable
// on mobile (tap still opens the same popover) instead of overflowing or
// being silently removed.
describe("NetworkSwitcher trigger collapses to icon-only on mobile (#6902)", () => {
  const triggerButton = (() => {
    const start = source.indexOf("<PopoverTrigger asChild>");
    const open = source.indexOf("<button", start);
    const close = source.indexOf("</button>", open) + "</button>".length;
    return source.slice(open, close);
  })();

  it("still has an explicit accessible name once the label text is hidden", () => {
    expect(triggerButton).toMatch(/aria-label=\{`Network: \$\{network\.label\}`\}/);
  });

  it("hides the network-label span below the sm breakpoint", () => {
    // ">{network.label}<", not the bare expression -- that substring also
    // occurs inside the aria-label/title template literals above.
    const labelEnd = triggerButton.indexOf(">{network.label}<");
    const spanOpen = triggerButton.lastIndexOf("<span", labelEnd);
    const labelSpan = triggerButton.slice(spanOpen, labelEnd);
    expect(labelSpan).toMatch(/className="[^"]*\bhidden\b[^"]*\bsm:inline\b[^"]*"/);
  });

  it("hides the chevron below the sm breakpoint", () => {
    const chevron = triggerButton.slice(triggerButton.indexOf("<ChevronDown"));
    expect(chevron).toMatch(/className="[^"]*\bhidden\b[^"]*\bsm:inline\b[^"]*"/);
  });

  it("never hides the globe icon or status dot, so the control stays visibly present at every width", () => {
    const globe = triggerButton.slice(
      triggerButton.indexOf("<Globe2"),
      triggerButton.indexOf("<Globe2") + 60,
    );
    expect(globe).not.toMatch(/\bhidden\b/);
    const dotSpanStart = triggerButton.indexOf('size-1.5 rounded-full", dotCls');
    const dotSpan = triggerButton.slice(dotSpanStart - 60, dotSpanStart + 40);
    expect(dotSpan).not.toMatch(/\bhidden\b/);
  });
});
