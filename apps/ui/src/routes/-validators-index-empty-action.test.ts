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
  fileURLToPath(
    new URL("../components/metagraphed/validators-index/operator-directory.tsx", import.meta.url),
  ),
  "utf8",
);
const streams = readFileSync(
  fileURLToPath(new URL("./-chain-stream-page.tsx", import.meta.url)),
  "utf8",
);
const shell = readFileSync(
  fileURLToPath(
    new URL("../components/metagraphed/chain-stream/stream-shell.tsx", import.meta.url),
  ),
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
    // Gated on NO filter being active, not just an empty search box: #11616
    // added a minimum-stake select and an identity filter, and each of them
    // can empty the table while the directory itself is full.
    const branch = validators.slice(
      validators.indexOf("const filtersActive"),
      validators.indexOf("No validators indexed yet"),
    );
    expect(branch).toContain("search.q");
    expect(branch).toContain("search.named");
    expect(branch).toContain("filtersActive ? (");
    expect(branch).toContain("No operators match these filters");
  });

  // #11620 folded the three chain streams into one page and one
  // `streamEmpty(filtersActive, subject, path)` helper, so the convention is
  // now stated once instead of three times -- and it reaches blocks and
  // extrinsics, which had a bare string and therefore said "match these
  // filters" to a reader who had set none.
  const helper = shell.slice(
    shell.indexOf("function streamEmpty"),
    shell.indexOf("\n}", shell.indexOf("function streamEmpty")),
  );

  it("offers the API link ONLY on the unfiltered empty state", () => {
    expect(helper).toContain("filtersActive ? (");
    expect(helper).toContain("indexed yet");
    expect(helper).toContain("action={{ label: `Open ${path}`");
    // The filtered branch comes first and carries no `action` at all: an API
    // link there would open the UNFILTERED endpoint, which is full.
    const filtered = helper.slice(0, helper.indexOf(") : ("));
    expect(filtered).toContain("match these filters");
    expect(filtered).not.toContain("action=");
  });

  it("is what all three streams pass, so none of them can drift", () => {
    // Each `empty={streamEmpty(...)}` call site, read as the whole call rather
    // than by searching for a subject string: `"extrinsics"` also appears in
    // `id="extrinsics"` a hundred lines earlier, and an indexOf on it would
    // pass while pointing at the wrong place entirely.
    const calls = [...streams.matchAll(/empty=\{streamEmpty\([\s\S]*?\)\}/g)].map((m) => m[0]);
    expect(calls).toHaveLength(3);
    const pairs = calls.map((call) => [
      call.match(/"([a-z ]+)",/)?.[1],
      call.match(/"(\/api\/v1\/[a-z-]+)"/)?.[1],
    ]);
    expect(pairs).toEqual([
      ["blocks", "/api/v1/blocks"],
      ["extrinsics", "/api/v1/extrinsics"],
      ["chain events", "/api/v1/chain-events"],
    ]);
    // No fourth `empty` prop taking a bare string behind the helper's back.
    expect(streams).not.toMatch(/empty="/);
  });
});
