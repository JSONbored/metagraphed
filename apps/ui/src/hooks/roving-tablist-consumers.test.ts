import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6391: the three `role="tablist"` widgets must actually consume the
// useRovingTablist hook (now in @jsonbored/ui-kit) -- a roving tabIndex, an
// onKeyDown wired to the hook, and a ref for focus movement. These components
// need the full app shell + a router to render, so (matching the
// api-source-context.test.tsx precedent) this suite asserts on their source
// rather than rendering them.
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
      expect(src).toMatch(/@jsonbored\/ui-kit/);
      expect(src).toMatch(/useRovingTablist\(/);
      expect(src).toMatch(/rovingTabIndex\(/);
      // the hook's onKeyDown is threaded onto the tab button
      expect(src).toMatch(/onKeyDown=\{/);
    });
  }
});
