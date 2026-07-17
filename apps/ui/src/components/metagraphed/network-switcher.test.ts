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
