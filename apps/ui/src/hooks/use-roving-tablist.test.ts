import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isTablistNavKey, nextTabIndex, rovingTabIndex } from "./use-roving-tablist";

describe("nextTabIndex", () => {
  it("ArrowRight/ArrowDown advance and wrap at the end", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextTabIndex(1, "ArrowDown", 3)).toBe(2);
    expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0); // wraps
  });

  it("ArrowLeft/ArrowUp retreat and wrap at the start", () => {
    expect(nextTabIndex(2, "ArrowLeft", 3)).toBe(1);
    expect(nextTabIndex(1, "ArrowUp", 3)).toBe(0);
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2); // wraps
  });

  it("Home/End jump to the first/last item", () => {
    expect(nextTabIndex(2, "Home", 4)).toBe(0);
    expect(nextTabIndex(0, "End", 4)).toBe(3);
  });

  it("returns null for keys it doesn't handle", () => {
    expect(nextTabIndex(0, "Enter", 3)).toBeNull();
    expect(nextTabIndex(0, " ", 3)).toBeNull();
    expect(nextTabIndex(0, "Tab", 3)).toBeNull();
    expect(nextTabIndex(0, "a", 3)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(nextTabIndex(0, "ArrowRight", 0)).toBeNull();
    expect(nextTabIndex(0, "Home", 0)).toBeNull();
  });
});

describe("isTablistNavKey", () => {
  it("recognizes the six navigation keys", () => {
    for (const k of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(isTablistNavKey(k)).toBe(true);
    }
  });

  it("rejects non-navigation keys", () => {
    for (const k of ["Enter", " ", "Tab", "Escape", "a"]) {
      expect(isTablistNavKey(k)).toBe(false);
    }
  });
});

describe("rovingTabIndex", () => {
  it("is 0 for the active tab and -1 otherwise", () => {
    expect(rovingTabIndex(1, 1)).toBe(0);
    expect(rovingTabIndex(0, 1)).toBe(-1);
    expect(rovingTabIndex(2, 1)).toBe(-1);
  });
});

// #6391: the three `role="tablist"` widgets must actually consume the hook — a
// roving tabIndex, an onKeyDown wired to the hook, and a ref for focus movement.
// These components need the full app shell + a router to render, so (matching the
// api-source-context.test.tsx precedent) this suite asserts on their source rather
// than rendering them.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("tablist consumers wire the roving-tablist contract", () => {
  const consumers = [
    ["EndpointKindTabs", "../components/metagraphed/endpoint-kind-tabs.tsx"],
    ["explorer section tabs", "../routes/explorer.tsx"],
    ["stake/unstake direction toggle", "../routes/subnets.$netuid.tsx"],
  ] as const;

  for (const [name, rel] of consumers) {
    it(`${name} imports and applies the hook`, () => {
      const src = read(rel);
      expect(src).toMatch(/use-roving-tablist/);
      expect(src).toMatch(/useRovingTablist\(/);
      expect(src).toMatch(/rovingTabIndex\(/);
      // the hook's onKeyDown is threaded onto the tab button
      expect(src).toMatch(/onKeyDown=\{/);
    });
  }
});
