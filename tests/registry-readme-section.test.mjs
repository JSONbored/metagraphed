import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  BEGIN,
  END,
  PROVENANCE_EXACT,
  loadOverlays,
  focusTags,
  links,
  renderCatalog,
  injectedReadme,
} from "../scripts/lib/registry-readme-section.mjs";

// --- focusTags: keep use-case tags, drop provenance/process noise -----------

describe("focusTags", () => {
  test("drops PROVENANCE_PREFIX (official-/baseline-/identity-) and PROVENANCE_EXACT tags, keeps the rest sorted", () => {
    const overlay = {
      categories: [
        "inference",
        "official-verified",
        "pilot",
        "baseline-seed",
        "training",
        "root",
        "identity-linked",
      ],
    };
    assert.deepEqual(focusTags(overlay), ["inference", "training"]);
  });

  test("every PROVENANCE_EXACT tag is filtered", () => {
    const overlay = { categories: [...PROVENANCE_EXACT, "compute"] };
    assert.deepEqual(focusTags(overlay), ["compute"]);
  });

  test("a missing categories array yields no tags", () => {
    assert.deepEqual(focusTags({}), []);
  });
});

// --- links: compose site/docs/repo, em-dash fallback ------------------------

describe("links", () => {
  test("joins the present links with ' · ' in site/docs/repo order", () => {
    assert.equal(
      links({
        website_url: "https://x.io",
        docs_url: "https://x.io/docs",
        source_repo: "https://github.com/x/x",
      }),
      "[site](https://x.io) · [docs](https://x.io/docs) · [repo](https://github.com/x/x)",
    );
  });

  test("omits absent links and keeps order", () => {
    assert.equal(
      links({ source_repo: "https://github.com/x/x" }),
      "[repo](https://github.com/x/x)",
    );
  });

  test("falls back to an em dash when no links exist", () => {
    assert.equal(links({}), "—");
  });
});

// --- renderCatalog: header stats, focus ranking, per-subnet bullets ---------

describe("renderCatalog", () => {
  const overlays = [
    {
      netuid: 1,
      name: "Alpha",
      categories: ["inference", "official-verified"],
      website_url: "https://alpha.io",
    },
    {
      netuid: 2,
      name: "Beta",
      categories: ["inference", "training"],
      docs_url: "https://beta.io/docs",
      source_repo: "https://github.com/beta/beta",
    },
    { netuid: 3, categories: ["pilot"] },
  ];

  test("counts subnets and site/docs/repo coverage in the header line", () => {
    const out = renderCatalog(overlays);
    assert.match(
      out,
      /\*\*3 curated subnets\*\* — 1 with a site, 1 with docs, 1 with a public repo\./,
    );
  });

  test("ranks focus areas by count then name (provenance tags excluded)", () => {
    const out = renderCatalog(overlays);
    assert.match(out, /\*\*Focus areas:\*\* `inference` 2 · `training` 1/);
    assert.doesNotMatch(out, /official-verified|pilot/);
  });

  test("renders one bullet per subnet, falling back to 'Subnet N' when unnamed", () => {
    const out = renderCatalog(overlays);
    assert.match(
      out,
      /- \*\*\[Alpha\]\(https:\/\/metagraph\.sh\/subnets\/1\)\*\* `SN1` — `inference` · \[site\]\(https:\/\/alpha\.io\)/,
    );
    // Unnamed netuid 3 falls back to "Subnet 3" with the em-dash link (no focus).
    assert.match(
      out,
      /- \*\*\[Subnet 3\]\(https:\/\/metagraph\.sh\/subnets\/3\)\*\* `SN3`\n/,
    );
  });
});

// --- injectedReadme: splice between markers, throw when malformed -----------

describe("injectedReadme", () => {
  test("replaces the content between the markers, preserving surrounding text", () => {
    const readme = `# Title\n\n${BEGIN}\nOLD\n${END}\n\nfooter`;
    const result = injectedReadme(readme, "NEW CATALOG");
    assert.equal(
      result,
      `# Title\n\n${BEGIN}\n\nNEW CATALOG\n\n${END}\n\nfooter`,
    );
    assert.match(result, /^# Title/);
    assert.match(result, /footer$/);
  });

  test("throws when a marker is missing", () => {
    assert.throws(
      () => injectedReadme(`no markers here`, "x"),
      /missing the .* markers/,
    );
  });

  test("throws when the end marker precedes the begin marker", () => {
    assert.throws(
      () => injectedReadme(`${END} ... ${BEGIN}`, "x"),
      /missing the .* markers/,
    );
  });
});

// --- loadOverlays: parse a directory of overlays, filter, sort by netuid ----

describe("loadOverlays", () => {
  test("parses *.json, drops entries without an integer netuid, sorts ascending", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "readme-overlays-"));
    try {
      writeFileSync(
        path.join(dir, "b.json"),
        JSON.stringify({ netuid: 7, name: "Seven" }),
      );
      writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify({ netuid: 2, name: "Two" }),
      );
      // No netuid -> filtered out.
      writeFileSync(path.join(dir, "c.json"), JSON.stringify({ name: "Nope" }));
      // Non-.json -> ignored entirely.
      writeFileSync(path.join(dir, "notes.txt"), "ignore me");

      const overlays = loadOverlays(dir);
      assert.deepEqual(
        overlays.map((o) => o.netuid),
        [2, 7],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
