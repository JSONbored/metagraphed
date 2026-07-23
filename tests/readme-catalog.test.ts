import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  BEGIN,
  END,
  focusTags,
  injectedReadme,
  links,
  renderCatalog,
} from "../scripts/lib/readme-catalog.ts";

describe("readme-catalog focusTags", () => {
  test("strips provenance prefix + exact tags, keeps real focus tags (sorted)", () => {
    const tags = focusTags({
      categories: [
        "inference",
        "official-source-repo", // PROVENANCE_PREFIX official-
        "baseline-curated", // PROVENANCE_PREFIX baseline-
        "identity-reviewed", // PROVENANCE_PREFIX identity-
        "pilot", // PROVENANCE_EXACT
        "root", // PROVENANCE_EXACT
        "system", // PROVENANCE_EXACT
        "native-only", // PROVENANCE_EXACT
        "macrocosmos", // PROVENANCE_EXACT
        "agents",
      ],
    });
    assert.deepEqual(tags, ["agents", "inference"]);
  });

  test("tolerates a missing categories array", () => {
    assert.deepEqual(focusTags({}), []);
  });
});

describe("readme-catalog links", () => {
  test("renders site/docs/repo in order when all three are present", () => {
    assert.equal(
      links({
        website_url: "https://s",
        docs_url: "https://d",
        source_repo: "https://r",
      }),
      "[site](https://s) · [docs](https://d) · [repo](https://r)",
    );
  });

  test("includes only the present links, preserving order", () => {
    assert.equal(links({ docs_url: "https://d" }), "[docs](https://d)");
    assert.equal(
      links({ website_url: "https://s", source_repo: "https://r" }),
      "[site](https://s) · [repo](https://r)",
    );
  });

  test("falls back to an em-dash when an overlay has none of the three", () => {
    assert.equal(links({}), "—");
  });
});

describe("readme-catalog renderCatalog", () => {
  test("ranks focus areas by count, breaking ties alphabetically", () => {
    const overlays = [
      { netuid: 1, categories: ["b-focus", "a-focus"] },
      { netuid: 2, categories: ["b-focus"] },
      { netuid: 3, categories: ["c-focus"] },
    ];
    const focusLine = renderCatalog(overlays)
      .split("\n")
      .find((line) => line.startsWith("**Focus areas:**"));
    // b-focus (2) leads; a-focus and c-focus tie at 1 -> alphabetical (a before c).
    assert.equal(
      focusLine,
      "**Focus areas:** `b-focus` 2 · `a-focus` 1 · `c-focus` 1",
    );
  });

  test("truncates the Focus areas line to 12 entries", () => {
    const overlays = Array.from({ length: 20 }, (_, index) => ({
      netuid: index + 1,
      categories: [`focus-${String(index).padStart(2, "0")}`],
    }));
    const focusLine = renderCatalog(overlays)
      .split("\n")
      .find((line) => line.startsWith("**Focus areas:**"));
    assert.equal((focusLine!.match(/`focus-\d+`/g) || []).length, 12);
  });
});

describe("readme-catalog injectedReadme", () => {
  const catalog = "CATALOG_BODY";

  test("splices the catalog between the markers without mutating outside content", () => {
    const readme = `intro text\n${BEGIN}\nOLD\n${END}\ntrailer text`;
    const out = injectedReadme(readme, catalog);
    assert.ok(out.startsWith("intro text\n"));
    assert.ok(out.endsWith("trailer text"));
    assert.ok(out.includes(`${BEGIN}\n\n${catalog}\n\n${END}`));
    assert.ok(!out.includes("OLD"));
  });

  test("throws when a marker is missing", () => {
    assert.throws(
      () => injectedReadme(`only ${BEGIN} here`, catalog),
      /missing/,
    );
    assert.throws(
      () => injectedReadme("no markers at all", catalog),
      /missing/,
    );
  });

  test("throws when the markers are out of order (END before BEGIN)", () => {
    assert.throws(
      () => injectedReadme(`${END} preamble ${BEGIN}`, catalog),
      /missing/,
    );
  });
});
