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
  fileURLToPath(new URL("./validators.index.tsx", import.meta.url)),
  "utf8",
);
const feed = readFileSync(
  fileURLToPath(new URL("../components/metagraphed/chain-events-feed.tsx", import.meta.url)),
  "utf8",
);

describe("empty-state 'Open the API' actions (#6340)", () => {
  it("Validators index links its empty state to /api/v1/validators", () => {
    const empty = validators.slice(
      validators.indexOf("No validators indexed yet"),
      validators.indexOf("No validators indexed yet") + 320,
    );
    expect(empty).toContain("action={{");
    expect(empty).toContain('label: "Open /api/v1/validators"');
    expect(empty).toContain("href: `${API_BASE}/api/v1/validators`");
    expect(empty).toContain("external: true");
  });

  it("Chain events feed links its UNFILTERED empty state to /api/v1/chain-events", () => {
    const empty = feed.slice(
      feed.indexOf("const emptyNode"),
      feed.indexOf("const emptyNode") + 700,
    );
    expect(empty).toContain("href: `${API_BASE}/api/v1/chain-events`");
    expect(empty).toContain("external: true");
  });

  it("keeps the filtered-empty chain-events case action-less", () => {
    // The action must be gated on filtersActive so a filter-empty view doesn't
    // suggest "open the API" (it'd show unfiltered data, not the filtered subset).
    const empty = feed.slice(
      feed.indexOf("const emptyNode"),
      feed.indexOf("const emptyNode") + 700,
    );
    expect(empty).toContain("filtersActive");
    // The action expression branches on filtersActive → undefined.
    expect(empty).toMatch(/action=\{\s*filtersActive\s*\?\s*undefined/);
  });
});
