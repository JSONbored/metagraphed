import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  README_LINK_LIMIT,
  README_KIND_LIMITS,
  isLikelyExampleLink,
  selectReviewableReadmeLinks,
  isReviewableReadmeLink,
} from "../scripts/lib/readme-links.mjs";

// --- exported constants -----------------------------------------------------

describe("README constants", () => {
  test("README_LINK_LIMIT is the global selection cap", () => {
    assert.equal(README_LINK_LIMIT, 5);
  });

  test("README_KIND_LIMITS pins the per-kind caps", () => {
    assert.deepEqual(README_KIND_LIMITS, {
      dashboard: 2,
      "data-artifact": 1,
      docs: 1,
      openapi: 2,
      "subnet-api": 2,
      website: 1,
    });
  });
});

// --- isLikelyExampleLink ----------------------------------------------------

describe("isLikelyExampleLink", () => {
  test("non-string input is never an example", () => {
    assert.equal(isLikelyExampleLink(undefined), false);
    assert.equal(isLikelyExampleLink(null), false);
    assert.equal(isLikelyExampleLink(123), false);
  });

  test("matches each example/quickstart marker", () => {
    assert.equal(isLikelyExampleLink("github.com /repo/example/foo.py"), true);
    assert.equal(isLikelyExampleLink("github.com /repo/examples/"), true);
    assert.equal(
      isLikelyExampleLink("quickstart docs.example.io /quickstart"),
      true,
    );
    assert.equal(isLikelyExampleLink("quick-start guide"), true);
    assert.equal(isLikelyExampleLink("getting-started page"), true);
    assert.equal(isLikelyExampleLink("tutorial site /tutorial/intro"), true);
    assert.equal(
      isLikelyExampleLink("notebook github.com /repo/demo.ipynb"),
      true,
    );
    assert.equal(
      isLikelyExampleLink("open in colab colab.research.google.com /drive/x"),
      true,
    );
  });

  test("plain api/docs links are not examples", () => {
    assert.equal(
      isLikelyExampleLink("api docs.example.io /api/v1/health"),
      false,
    );
    assert.equal(isLikelyExampleLink("documentation site /docs/intro"), false);
    assert.equal(isLikelyExampleLink(""), false);
  });
});

// --- isReviewableReadmeLink -------------------------------------------------

describe("isReviewableReadmeLink", () => {
  test("rejects links missing a url or classification kind", () => {
    assert.equal(isReviewableReadmeLink(null), false);
    assert.equal(
      isReviewableReadmeLink({ classification: { kind: "docs" } }),
      false,
    );
    assert.equal(isReviewableReadmeLink({ url: "https://example.com" }), false);
    assert.equal(
      isReviewableReadmeLink({
        url: "https://example.com",
        classification: {},
      }),
      false,
    );
  });

  test("rejects generic reference hosts even when the netuid matches", () => {
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://taostats.io/subnet/42",
          classification: { kind: "dashboard" },
        },
        { netuid: 42 },
      ),
      false,
    );
  });

  test("rejects subdomains of generic reference hosts", () => {
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://api.taostats.io/sn-42",
          classification: { kind: "subnet-api" },
        },
        { netuid: 42 },
      ),
      false,
    );
  });

  test("accepts a project link with netuid affinity in the path", () => {
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://example.com/sn-42/api",
          classification: { kind: "subnet-api" },
        },
        { netuid: 42 },
      ),
      true,
    );
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://example.com/subnet-42/",
          classification: { kind: "docs" },
        },
        { netuid: 42 },
      ),
      true,
    );
  });

  test("netuid affinity respects the trailing digit boundary", () => {
    // netuid 1 must NOT match "sn123" (a longer number).
    assert.equal(
      isReviewableReadmeLink(
        { url: "https://example.com/sn123", classification: { kind: "docs" } },
        { netuid: 1 },
      ),
      false,
    );
  });

  test("netuid affinity matches via the compacted haystack when separators are stripped", () => {
    // "sn42" with no delimiter is caught only by the compacted-value regex.
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://exampledotcomsn42.io/x",
          classification: { kind: "docs" },
        },
        { netuid: 42 },
      ),
      true,
    );
    // The compact path still honors the trailing-digit guard: 4 ≠ "sn42".
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://exampledotcomsn42.io/x",
          classification: { kind: "docs" },
        },
        { netuid: 4 },
      ),
      false,
    );
  });

  test("rejects links whose url cannot be parsed", () => {
    assert.equal(
      isReviewableReadmeLink(
        { url: "not a url", classification: { kind: "docs" } },
        { netuid: 42 },
      ),
      false,
    );
  });

  test("accepts a project link via a repo-name token", () => {
    assert.equal(
      isReviewableReadmeLink(
        { url: "https://myproject.io/docs", classification: { kind: "docs" } },
        { repo: { owner: "acme", repo: "myproject" } },
      ),
      true,
    );
  });

  test("repo tokens shorter than 3 chars or in the stopword set grant no affinity", () => {
    // "io" is too short (length < 3) → filtered out → no affinity.
    assert.equal(
      isReviewableReadmeLink(
        { url: "https://io.example.com/x", classification: { kind: "docs" } },
        { repo: { owner: "", repo: "io" } },
      ),
      false,
    );
    // "network" is a stopword → filtered out even though it appears in the host.
    assert.equal(
      isReviewableReadmeLink(
        {
          url: "https://network.example.com/x",
          classification: { kind: "docs" },
        },
        { repo: { owner: "", repo: "network" } },
      ),
      false,
    );
  });

  test("rejects a link with neither netuid nor repo affinity", () => {
    assert.equal(
      isReviewableReadmeLink(
        { url: "https://unrelated.io/docs", classification: { kind: "docs" } },
        { repo: {} },
      ),
      false,
    );
  });
});

// --- selectReviewableReadmeLinks --------------------------------------------

function link(url, kind) {
  return { url, classification: { kind }, label: "" };
}

describe("selectReviewableReadmeLinks", () => {
  test("nullish links list yields an empty selection", () => {
    assert.deepEqual(selectReviewableReadmeLinks(null), []);
    assert.deepEqual(selectReviewableReadmeLinks(undefined), []);
  });

  test("drops links that are not reviewable", () => {
    const selected = selectReviewableReadmeLinks(
      [
        link("https://example.com/sn-42/api", "subnet-api"),
        link("https://unrelated.io/api", "subnet-api"), // no affinity
      ],
      { netuid: 42 },
    );
    assert.deepEqual(
      selected.map((entry) => entry.url),
      ["https://example.com/sn-42/api"],
    );
  });

  test("deduplicates by (kind, registrable domain)", () => {
    const selected = selectReviewableReadmeLinks(
      [
        link("https://api.example.com/v1", "subnet-api"),
        link("https://api.example.com/v2", "subnet-api"),
      ],
      { repo: { owner: "acme", repo: "example" } },
    );
    // Same kind + same registrable domain → only the first survives.
    assert.equal(selected.length, 1);
    assert.equal(selected[0].url, "https://api.example.com/v1");
  });

  test("enforces the per-kind cap across distinct domains", () => {
    const selected = selectReviewableReadmeLinks(
      [
        link("https://exampleone.io/sn-42", "subnet-api"),
        link("https://exampletwo.io/sn-42", "subnet-api"),
        link("https://examplethree.io/sn-42", "subnet-api"),
      ],
      { netuid: 42 },
    );
    // subnet-api cap is 2.
    assert.equal(selected.length, 2);
  });

  test("unknown kinds fall back to a cap of one", () => {
    const selected = selectReviewableReadmeLinks(
      [
        link("https://exampleone.io/sn-42", "sse"),
        link("https://exampletwo.io/sn-42", "sse"),
      ],
      { netuid: 42 },
    );
    assert.equal(selected.length, 1);
  });

  test("honors the global limit option and stops early", () => {
    const selected = selectReviewableReadmeLinks(
      [
        link("https://exampleone.io/sn-42", "subnet-api"),
        link("https://exampletwo.io/sn-42", "dashboard"),
      ],
      { netuid: 42, limit: 1 },
    );
    assert.equal(selected.length, 1);
  });
});
