import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6420: the "Compare" button was a plain sibling of <Sheet>, not its trigger,
// so Radix had no trigger node to restore focus to on close — closing the drawer
// dropped focus to <body>. Making the button a <SheetTrigger> inside <Sheet>
// lets Radix track it and return focus. Verified in a real browser: before,
// Escape leaves focus on <body>; after, it returns to the Compare button.
//
// Source assertion (this component needs a router + live queries to render, and
// the suite is node-environment; the repo tests this way — ui-kit list-shell.test.ts).
const source = readFileSync(
  fileURLToPath(new URL("./subnet-compare-drawer.tsx", import.meta.url)),
  "utf8",
);

describe("SubnetCompareDrawer returns focus to its trigger", () => {
  it("wraps the Compare button in a SheetTrigger", () => {
    // The trigger must be a SheetTrigger with the button as its asChild child —
    // that is the only thing that makes Radix restore focus on close.
    const trigger = source.slice(
      source.indexOf("<SheetTrigger"),
      source.indexOf("</SheetTrigger>"),
    );
    expect(trigger).toContain("asChild");
    expect(trigger).toContain("Compare");
  });

  it("imports SheetTrigger", () => {
    expect(source).toContain("SheetTrigger");
  });

  it("no longer opens via a bare onClick sibling button", () => {
    // The old bug: <button onClick={() => setOpen(true)}> as a fragment sibling
    // of <Sheet>. SheetTrigger drives the open state through Sheet's context now,
    // so that manual onClick is gone.
    expect(source).not.toContain("onClick={() => setOpen(true)}");
  });

  it("keeps <Sheet> as the single root so the trigger lives inside it", () => {
    // A SheetTrigger only wires focus-return when it is within the <Sheet> tree;
    // the component now returns <Sheet>…</Sheet> directly rather than a fragment
    // with the button outside it.
    const ret = source.slice(source.indexOf("return ("));
    expect(ret).toContain("<Sheet open={open}");
    // The trigger precedes the content, both inside the Sheet.
    expect(ret.indexOf("<SheetTrigger")).toBeGreaterThan(ret.indexOf("<Sheet open"));
    expect(ret.indexOf("<SheetContent")).toBeGreaterThan(ret.indexOf("<SheetTrigger"));
  });
});
