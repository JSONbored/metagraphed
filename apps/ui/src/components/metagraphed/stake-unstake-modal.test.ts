import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6415: StakeUnstakeModal's trigger (a caller-supplied render-prop) was a plain
// sibling of <Sheet>, not its trigger, so Radix had no trigger node to restore
// focus to on close and dropped focus to <body>. Wrapping the render-prop in
// <SheetTrigger asChild> inside <Sheet> is the same fix landed for
// SubnetCompareDrawer (#6527) and TakeManagementModal (#6531). Unlike those, the
// "Delegate" trigger here is not wallet-gated, so it's verified in a browser:
// before, Escape leaves focus on <body>; after, it returns to the trigger.
const source = readFileSync(
  fileURLToPath(new URL("./stake-unstake-modal.tsx", import.meta.url)),
  "utf8",
);

describe("StakeUnstakeModal returns focus to its trigger", () => {
  it("wraps the render-prop trigger in a SheetTrigger", () => {
    expect(source).toContain("<SheetTrigger asChild>{trigger(() => setOpen(true))}</SheetTrigger>");
  });

  it("imports SheetTrigger", () => {
    const imports = source.slice(0, source.indexOf('} from "@jsonbored/ui-kit";'));
    expect(imports).toContain("SheetTrigger");
  });

  // Just the component's own return block, so fragments in later helpers don't leak in.
  const componentReturn = (() => {
    const start = source.indexOf("return (");
    const end = source.indexOf("</Sheet>\n  );", start) + "</Sheet>\n  );".length;
    return source.slice(start, end);
  })();

  it("no longer renders the trigger as a fragment sibling outside <Sheet>", () => {
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
    expect(source).toContain("if (!flow.canClose) return;");
    expect(source).toContain("<Sheet open={open} onOpenChange={handleOpenChange}>");
  });
});
