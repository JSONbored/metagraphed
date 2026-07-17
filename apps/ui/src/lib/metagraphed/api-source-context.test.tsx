import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6418: the API-source drawer (ApiDrawer) and its trigger (ApiDrawerTrigger) are
// separate components sharing this context; the drawer's <Sheet> has no in-tree
// <SheetTrigger>, so on close Radix had no trigger node and dropped focus to
// <body>. Verified in a browser: opening via the header button then pressing
// Escape left focus on <body>; after, it returns to the trigger. (The ⌘J path
// already restored via Radix's focus scope; this makes the button path consistent
// with it.) The context now records the element focused at open() and ApiDrawer
// restores it in onCloseAutoFocus.
//
// Source assertions: these components need the full app shell + a router to
// render, and this suite is node-environment.
const context = readFileSync(
  fileURLToPath(new URL("./api-source-context.tsx", import.meta.url)),
  "utf8",
);
const drawer = readFileSync(
  fileURLToPath(new URL("../../components/metagraphed/api-drawer.tsx", import.meta.url)),
  "utf8",
);

describe("ApiDrawer returns focus to its trigger (#6418)", () => {
  it("the context exposes a restoreFocusRef", () => {
    expect(context).toContain("restoreFocusRef: RefObject<HTMLElement | null>");
    expect(context).toContain("restoreFocusRef");
  });

  it("open() records document.activeElement before opening", () => {
    // The capture must happen in open() (used by both the button and ⌘J), and
    // before setOpen(true) — once the drawer has focus, activeElement is inside it.
    const open = context.slice(
      context.indexOf("const open = useCallback"),
      context.indexOf("const register"),
    );
    expect(open).toContain("restoreFocusRef.current");
    expect(open).toContain("document.activeElement");
    expect(open.indexOf("restoreFocusRef.current")).toBeLessThan(open.indexOf("setOpen(true)"));
  });

  it("open() and restoreFocusRef are on the context value", () => {
    const value = context.slice(context.indexOf("useMemo<Ctx>"));
    expect(value).toContain("open,");
    expect(value).toContain("restoreFocusRef");
  });

  it("ApiDrawer restores focus in onCloseAutoFocus, guarding a detached node", () => {
    expect(drawer).toContain("onCloseAutoFocus");
    const handler = drawer.slice(drawer.indexOf("onCloseAutoFocus"));
    expect(handler).toContain("restoreFocusRef.current");
    // isConnected guards a trigger removed from the DOM while the drawer was open.
    expect(handler).toContain("isConnected");
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain(".focus()");
  });
});
