import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyGapNote,
  collectStaleGapNotes,
  findStaleGapNotes,
  isFirstPartySurface,
} from "../scripts/stale-gap-notes.ts";

describe("classifyGapNote", () => {
  test("classifies each observed 'No verified ... yet' phrasing", () => {
    assert.equal(classifyGapNote("No verified SSE/event stream yet."), "sse");
    assert.equal(
      classifyGapNote(
        "No verified machine-readable OpenAPI/Swagger schema yet.",
      ),
      "openapi",
    );
    assert.equal(
      classifyGapNote("No verified safe public subnet API endpoint yet."),
      "subnet-api",
    );
    assert.equal(
      classifyGapNote("No verified standalone static data artifact yet."),
      "data-artifact",
    );
    assert.equal(
      classifyGapNote("No verified live source repository yet."),
      "source-repo",
    );
    assert.equal(classifyGapNote("No verified docs site yet."), "docs");
    assert.equal(
      classifyGapNote("No verified dashboard surface yet."),
      "dashboard",
    );
    assert.equal(
      classifyGapNote("No verified official website yet."),
      "website",
    );
  });

  test("ignores notes that don't start with 'No verified'", () => {
    assert.equal(
      classifyGapNote("Native chain name currently reports as deprecated."),
      null,
    );
  });

  test("ignores 'No verified' notes with no recognizable kind keyword", () => {
    assert.equal(
      classifyGapNote("No publicly verified team/operator profile yet."),
      null,
    );
  });

  test("ignores 'No verified ...' notes that aren't a still-missing claim", () => {
    // No "yet" — this is an explicit exclusion, not a "not found" claim.
    assert.equal(
      classifyGapNote(
        "No verified official website; the domain fails to resolve.",
      ),
      null,
    );
  });

  test("ignores non-string input", () => {
    assert.equal(classifyGapNote(undefined), null);
    assert.equal(classifyGapNote(null), null);
  });
});

describe("isFirstPartySurface", () => {
  const providersById = new Map([
    ["acme", { id: "acme", kind: "subnet-team" }],
    ["taomarketcap", { id: "taomarketcap", kind: "data-provider" }],
  ]);

  test("true for a subnet-team provider", () => {
    assert.equal(
      isFirstPartySurface({ provider: "acme" }, providersById),
      true,
    );
  });

  test("false for a third-party aggregator provider", () => {
    assert.equal(
      isFirstPartySurface({ provider: "taomarketcap" }, providersById),
      false,
    );
  });

  test("false when the provider id isn't registered", () => {
    assert.equal(
      isFirstPartySurface({ provider: "missing-provider" }, providersById),
      false,
    );
  });
});

describe("findStaleGapNotes", () => {
  const providersById = new Map([
    ["acme", { id: "acme", kind: "subnet-team" }],
    ["taomarketcap", { id: "taomarketcap", kind: "data-provider" }],
  ]);

  test("flags a note contradicted by the file's own first-party surface", () => {
    const document = {
      curation: {
        gap_notes: ["No verified machine-readable OpenAPI/Swagger schema yet."],
      },
      surfaces: [{ id: "acme-openapi", kind: "openapi", provider: "acme" }],
    };
    const stale = findStaleGapNotes(document, providersById);
    assert.deepEqual(stale, [
      {
        note: "No verified machine-readable OpenAPI/Swagger schema yet.",
        kind: "openapi",
        surface_id: "acme-openapi",
      },
    ]);
  });

  test("does not flag a note describing a surface that genuinely doesn't exist", () => {
    const document = {
      curation: { gap_notes: ["No verified SSE/event stream yet."] },
      surfaces: [{ id: "acme-openapi", kind: "openapi", provider: "acme" }],
    };
    assert.deepEqual(findStaleGapNotes(document, providersById), []);
  });

  test("does not flag when the only matching surface is a third-party aggregator (oneoneone.json case)", () => {
    const document = {
      curation: {
        gap_notes: ["No verified safe public subnet API endpoint yet."],
      },
      surfaces: [
        {
          id: "sn-111-taomarketcap-subnet-api",
          kind: "subnet-api",
          provider: "taomarketcap",
        },
      ],
    };
    assert.deepEqual(findStaleGapNotes(document, providersById), []);
  });

  test("handles a document with no curation or surfaces blocks", () => {
    assert.deepEqual(findStaleGapNotes({}, providersById), []);
  });
});

describe("findStaleGapNotes (fixtures reproducing real registry bugs)", () => {
  const providersById = new Map([
    ["chutes", { id: "chutes", kind: "subnet-team" }],
    ["gittensor", { id: "gittensor", kind: "subnet-team" }],
  ]);

  // Frozen snapshots of the exact real chutes.json/gittensor.json shapes that
  // motivated this script (both fixed in the same PR that added this
  // regression case -- see #5815/#5849/#5851 and onward for the wider
  // stale-note sweep). Synthetic on purpose: a live-registry read here would
  // make this test fail the moment someone fixes the real file, which is
  // exactly the outcome this tool exists to produce.
  test("reproduces the documented chutes.json finding", () => {
    const document = {
      curation: {
        gap_notes: [
          "No verified machine-readable OpenAPI/Swagger schema yet.",
          "No verified SSE/event stream yet.",
        ],
      },
      surfaces: [
        { id: "sn-64-chutes-openapi", kind: "openapi", provider: "chutes" },
        { id: "sn-64-chutes-sse", kind: "sse", provider: "chutes" },
      ],
    };
    const kinds = findStaleGapNotes(document, providersById)
      .map((n) => n.kind)
      .sort();
    assert.deepEqual(kinds, ["openapi", "sse"]);
  });

  test("reproduces the documented gittensor.json finding", () => {
    const document = {
      curation: {
        gap_notes: [
          "No verified dashboard surface yet.",
          "No verified OpenAPI/Swagger surface yet.",
          "No verified SSE/event stream yet.",
          "Bounty state is documented through public CLI flows, but no unauthenticated public API has been verified yet.",
        ],
      },
      surfaces: [
        {
          id: "sn-74-gittensor-dashboard",
          kind: "dashboard",
          provider: "gittensor",
        },
        {
          id: "sn-74-gittensor-openapi",
          kind: "openapi",
          provider: "gittensor",
        },
      ],
    };
    const kinds = findStaleGapNotes(document, providersById)
      .map((n) => n.kind)
      .sort();
    assert.deepEqual(kinds, ["dashboard", "openapi"]);
  });
});

describe("collectStaleGapNotes (real registry)", () => {
  test("does not flag oneoneone.json's third-party subnet-api note", async () => {
    const report = await collectStaleGapNotes();
    const oneoneone = report.subnets.find((s) => s.file === "oneoneone.json");
    const flaggedKinds = (oneoneone?.stale_notes || []).map((n) => n.kind);
    assert.ok(!flaggedKinds.includes("subnet-api"));
  });
});
