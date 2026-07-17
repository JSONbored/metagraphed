import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6416: the hamburger button lives in the header, not inside the mobile-nav
// <Sheet>, so it can't be a <SheetTrigger> and Radix had no trigger node to
// restore focus to on close — it dropped focus to <body> on every page for every
// mobile/tablet keyboard user. The hamburger now carries a ref, and the Sheet's
// onCloseAutoFocus restores it (the hamburger is this Sheet's only opener).
// Verified in a browser at a mobile viewport: before, Escape leaves focus on
// <body>; after, it returns to the hamburger.
//
// Source assertion: app-shell needs a router + full provider tree to render, and
// the suite is node-environment.
const source = readFileSync(fileURLToPath(new URL("./app-shell.tsx", import.meta.url)), "utf8");

describe("mobile nav Sheet returns focus to the hamburger (#6416)", () => {
  it("keeps a ref on the hamburger button", () => {
    expect(source).toContain("const hamburgerRef = useRef<HTMLButtonElement | null>(null)");
    // The ref is attached to the aria-label="Open menu" button.
    const openMenu = source.indexOf('aria-label="Open menu"');
    const tag = source.slice(source.lastIndexOf("<button", openMenu), openMenu);
    expect(tag).toContain("ref={hamburgerRef}");
  });

  it("restores that ref in the mobile Sheet's onCloseAutoFocus", () => {
    const sheet = source.indexOf("open={mobileOpen}");
    const handler = source.slice(sheet, source.indexOf("</Sheet>", sheet));
    expect(handler).toContain("onCloseAutoFocus");
    expect(handler).toContain("hamburgerRef.current");
    // isConnected guards a hamburger unmounted while the sheet was open;
    // preventDefault stops Radix's own (body) auto-focus first.
    expect(handler).toContain("isConnected");
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain(".focus()");
  });

  it("still opens the sheet from the hamburger's onClick", () => {
    // The fix must not change how the menu opens.
    expect(source).toContain("onClick={() => setMobileOpen(true)}");
  });
});
