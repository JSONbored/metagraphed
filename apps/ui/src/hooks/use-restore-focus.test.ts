import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canRestoreFocusTo } from "./use-restore-focus";

// #6417: capture-and-restore focus for the command palette's discrete-button
// open paths, factored into a shared hook (the #6548 review asked for exactly
// this instead of a fourth copy). This suite runs in a node environment, so the
// pure guard is tested with duck-typed stand-ins and the app-shell wiring is
// asserted on source (the component needs the full app shell + router to render).

const el = (isConnected: boolean) => ({ isConnected }) as unknown as Element;

describe("canRestoreFocusTo", () => {
  it("is false for null", () => {
    expect(canRestoreFocusTo(null)).toBe(false);
  });

  it("is false for a detached element (opener unmounted while overlay was open)", () => {
    expect(canRestoreFocusTo(el(false))).toBe(false);
  });

  it("is true for an element still in the document", () => {
    expect(canRestoreFocusTo(el(true))).toBe(true);
  });
});

const appShell = readFileSync(
  fileURLToPath(new URL("../components/metagraphed/app-shell.tsx", import.meta.url)),
  "utf8",
);

describe("app-shell wires the command palette focus-restore (#6417)", () => {
  it("uses the shared useRestoreFocus hook", () => {
    expect(appShell).toContain("useRestoreFocus");
    expect(appShell).toContain("use-restore-focus");
  });

  it("captures the opener on the discrete-button open paths", () => {
    // The mobile search icon and the omnibox "Full search" entry both open via a
    // capture-then-open helper, not a bare setPaletteOpen(true).
    expect(appShell).toContain("openPaletteFromButton");
    expect(appShell).toContain("paletteFocus.capture()");
    expect(appShell).toContain("onClick={openPaletteFromButton}");
    expect(appShell).toContain("onOpenPalette={openPaletteFromButton}");
  });

  it("restores focus when the palette closes, via onOpenChange", () => {
    expect(appShell).toContain("onPaletteOpenChange");
    expect(appShell).toContain("paletteFocus.restore()");
    expect(appShell).toContain("onOpenChange={onPaletteOpenChange}");
  });
});
