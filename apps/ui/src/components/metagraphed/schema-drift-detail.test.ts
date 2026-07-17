import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { shouldRestoreFocus } from "./schema-drift-detail";

// #6555: SchemaDriftDetail is a URL-param-driven Dialog with no in-tree
// <DialogTrigger>, so Radix dropped focus to <body> on close. It now records the
// element focused on open and restores it in onCloseAutoFocus (the api-drawer.tsx
// #6418 pattern). The component needs the full app shell to render, so — matching
// api-source-context.test.tsx — the wiring is asserted on source; the pure focus
// guard is unit-tested directly.

// This suite runs in a plain node environment (no DOM), so exercise the guard
// with duck-typed stand-ins for the one property it reads (isConnected) rather
// than real elements.
const fakeEl = (isConnected: boolean) => ({ isConnected }) as unknown as HTMLElement;

describe("shouldRestoreFocus", () => {
  it("is false for null", () => {
    expect(shouldRestoreFocus(null)).toBe(false);
  });

  it("is false for a detached element (removed from the DOM before close)", () => {
    expect(shouldRestoreFocus(fakeEl(false))).toBe(false);
  });

  it("is true for an element still in the document", () => {
    expect(shouldRestoreFocus(fakeEl(true))).toBe(true);
  });
});

const source = readFileSync(
  fileURLToPath(new URL("./schema-drift-detail.tsx", import.meta.url)),
  "utf8",
);

describe("SchemaDriftDetail returns focus to its opener on close (#6555)", () => {
  it("records document.activeElement when the dialog opens", () => {
    expect(source).toContain("restoreFocusRef");
    expect(source).toContain("document.activeElement");
    // the capture is gated on `open` so it happens at open time, not on every render
    expect(source).toMatch(/if\s*\(open\)/);
  });

  it("restores focus in the Dialog's onCloseAutoFocus, preventing Radix's default", () => {
    expect(source).toContain("onCloseAutoFocus");
    const handler = source.slice(source.indexOf("onCloseAutoFocus"));
    expect(handler).toContain("shouldRestoreFocus");
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain(".focus()");
  });
});
