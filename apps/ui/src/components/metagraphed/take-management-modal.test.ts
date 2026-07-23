import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6419: TakeManagementModal's trigger (a caller-supplied render-prop) was a
// plain sibling of <Sheet>, not its trigger — so Radix had no trigger node to
// restore focus to on close, and closing the modal dropped focus to <body>.
// Wrapping the render-prop in <SheetTrigger asChild> inside <Sheet> is the same
// mechanism proven in-browser for SubnetCompareDrawer (#6420/#6527): before,
// Escape leaves focus on <body>; after, it returns to the trigger.
//
// Owner-gated (only rendered for the connected owning coldkey), so a headless
// keyboard demo of this instance isn't practical — hence source assertions on
// the wiring, plus the linked in-browser proof of the identical mechanism.
const source = readFileSync(
  fileURLToPath(new URL("./take-management-modal.tsx", import.meta.url)),
  "utf8",
);

describe("TakeManagementModal returns focus to its trigger", () => {
  it("wraps the render-prop trigger in a SheetTrigger", () => {
    expect(source).toContain("<SheetTrigger asChild>{trigger(() => setOpen(true))}</SheetTrigger>");
  });

  it("imports SheetTrigger", () => {
    const imports = source.slice(0, source.indexOf('} from "@jsonbored/ui-kit";'));
    expect(imports).toContain("SheetTrigger");
  });

  // Just the component's own return block (up to its closing </Sheet>), so
  // fragments in unrelated helper functions later in the file don't leak in.
  const componentReturn = (() => {
    const start = source.indexOf("return (");
    const end = source.indexOf("</Sheet>\n  );", start) + "</Sheet>\n  );".length;
    return source.slice(start, end);
  })();

  it("no longer renders the trigger as a fragment sibling outside <Sheet>", () => {
    // The old shape: return (<>{trigger(...)}<Sheet>…). A SheetTrigger only
    // wires focus-return when it sits inside <Sheet>, so the component now
    // returns <Sheet> directly with the trigger within it.
    expect(componentReturn.trimStart()).toMatch(/^return \(\s*<Sheet open=\{open\}/);
    expect(componentReturn).not.toContain("<>");
  });

  it("keeps the trigger ahead of the content, both inside <Sheet>", () => {
    const sheet = componentReturn.indexOf("<Sheet open");
    const trigger = componentReturn.indexOf("<SheetTrigger");
    const content = componentReturn.indexOf("<SheetContent");
    expect(sheet).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(sheet);
    expect(content).toBeGreaterThan(trigger);
  });

  it("preserves the signature-in-flight close guard (handleOpenChange)", () => {
    // The focus change must not weaken the guard that blocks closing mid-signature.
    expect(source).toContain("if (!flow.canClose) return;");
    expect(source).toContain("<Sheet open={open} onOpenChange={handleOpenChange}>");
  });
});
