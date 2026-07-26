import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6340: the Validators index and the Chain events feed's genuinely-empty
// EmptyState had no `action` link to the underlying API, unlike every other
// single-feed list page (blocks.index.tsx etc.). Both now offer "Open the API".
// The chain-events filtered-empty case ("No chain events match these filters")
// deliberately keeps no action, matching the filter-empty convention.
//
// Source assertions: the empty branch only renders when the live feed is empty
// (it isn't), so a rendered test can't reach it; this suite is node-environment.
const validators = readFileSync(
  fileURLToPath(new URL("./-validators-index-page.tsx", import.meta.url)),
  "utf8",
);
const feed = readFileSync(
  fileURLToPath(new URL("../components/metagraphed/chain-events-feed.tsx", import.meta.url)),
  "utf8",
);

describe("empty-state 'Open the API' actions", () => {
  // #8251: the empty state now distinguishes a genuinely-empty directory from
  // a search that matched nothing -- the API link only renders for the former
  // (a filter-empty view suggesting "open the API" would show unfiltered
  // data, not the filtered subset -- the same convention chain-events-feed's
  // own filtered-empty case pins below).
  it("Validators index links its UNFILTERED empty state to /api/v1/validators", () => {
    const empty = validators.slice(
      validators.indexOf("No validators indexed yet"),
      validators.indexOf("No validators indexed yet") + 700,
    );
    expect(empty).toContain('label: "Open /api/v1/validators"');
    expect(empty).toContain("href: `${API_BASE}/api/v1/validators`");
    expect(empty).toContain("external: true");
    // Gated on the search box being empty -- search.q ? undefined : {...}.
    expect(empty).toContain("search.q");
    expect(empty).toContain("undefined");
  });

  // The whole `const emptyNode = (...)` declaration, however long its comments grow.
  const emptyNodeStart = feed.indexOf("const emptyNode");
  const feedEmpty = feed.slice(emptyNodeStart, feed.indexOf("\n  );", emptyNodeStart));

  it("Chain events feed links its UNFILTERED empty state to /api/v1/chain-events", () => {
    expect(feedEmpty).toContain("href: `${API_BASE}/api/v1/chain-events`");
    expect(feedEmpty).toContain("external: true");
  });

  it("keeps the filtered-empty chain-events cases action-less", () => {
    // The action must be gated so a filter-empty view doesn't suggest "open the
    // API" (it'd show unfiltered data, not the filtered subset). #8253 added a
    // second filtered case: the noise toggle hiding every row on the page.
    expect(feedEmpty).toMatch(/action=\{\s*filtersActive \|\| hiddenCount > 0\s*\?\s*undefined/);
  });

  it("distinguishes all-hidden-by-noise from a genuinely empty chain-events feed", () => {
    // #8253: "we hid them" and "there are none" are different answers -- the
    // all-hidden title names the toggle as the fix rather than claiming the
    // backfill hasn't run.
    expect(feedEmpty).toContain("hiddenCount > 0");
    expect(feedEmpty).toContain("system noise");
    expect(feedEmpty).toContain("No chain events indexed yet");
  });
});
