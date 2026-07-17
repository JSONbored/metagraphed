import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6417: the ⌘K command palette (a Radix Dialog) has no <Dialog.Trigger> — it
// opens from a global keydown, the omnibox, and the mobile search icon — so Radix
// had no trigger node and dropped focus to <body> on close. The shell now
// captures document.activeElement when the palette opens and restores it on
// close. Verified in a browser (mobile viewport): opening from the search icon
// then Escape returns focus to the icon; before, it went to <body>.
//
// A synchronous restore in onOpenChange would be overridden by Radix's own
// close-autofocus, so it's deferred a frame — CommandDialog's DialogContent
// doesn't forward onCloseAutoFocus, so that (cleaner) hook isn't reachable here.
//
// Source assertion: app-shell needs a router + full provider tree, and the suite
// is node-environment.
const source = readFileSync(fileURLToPath(new URL("./app-shell.tsx", import.meta.url)), "utf8");

describe("command palette returns focus to its opener (#6417)", () => {
  it("captures the focused element when the palette opens", () => {
    const openPalette = source.slice(
      source.indexOf("const openPalette = useCallback"),
      source.indexOf("const handlePaletteOpenChange"),
    );
    expect(openPalette).toContain("paletteReturnRef.current");
    expect(openPalette).toContain("document.activeElement");
    expect(openPalette).toContain("setPaletteOpen(true)");
  });

  it("restores focus on close, deferred past Radix's close-autofocus", () => {
    const handler = source.slice(
      source.indexOf("const handlePaletteOpenChange = useCallback"),
      source.indexOf("}, []);", source.indexOf("handlePaletteOpenChange")) + 6,
    );
    expect(handler).toContain("requestAnimationFrame");
    expect(handler).toContain(".focus()");
    // isConnected guards an opener unmounted while the palette was open.
    expect(handler).toContain("isConnected");
  });

  it("routes the discrete openers through openPalette", () => {
    // The omnibox "Full search" and the mobile search icon are the triggers the
    // issue requires to restore focus.
    expect(source).toContain("<NavOmnibox onOpenPalette={openPalette} />");
    const searchBtn = source.indexOf('aria-label="Open search"');
    const onClick = source.lastIndexOf("onClick={openPalette}", searchBtn);
    expect(onClick).toBeGreaterThan(-1);
  });

  it("captures on the ⌘K path only when opening, and wires onOpenChange", () => {
    // ⌘K toggles; capturing on a ⌘K-close would overwrite the pre-open element.
    expect(source).toContain("if (!paletteOpenRef.current)");
    expect(source).toContain(
      "<CommandPalette open={paletteOpen} onOpenChange={handlePaletteOpenChange} />",
    );
  });
});
