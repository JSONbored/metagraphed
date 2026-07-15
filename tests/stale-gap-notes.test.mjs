import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyGapNote,
  collectStaleGapNotes,
  findStaleGapNotes,
  isFirstPartySurface,
} from "../scripts/stale-gap-notes.mjs";

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

describe("collectStaleGapNotes (real registry)", () => {
  test("reproduces the documented chutes.json and gittensor.json findings", async () => {
    const report = await collectStaleGapNotes();
    assert.ok(report.subnet_count > 0);
    assert.ok(report.stale_note_count >= report.subnet_count);

    const chutes = report.subnets.find((s) => s.file === "chutes.json");
    assert.ok(chutes, "chutes.json should have stale notes");
    const chutesKinds = chutes.stale_notes.map((n) => n.kind).sort();
    assert.deepEqual(chutesKinds, ["openapi", "sse"]);

    const gittensor = report.subnets.find((s) => s.file === "gittensor.json");
    assert.ok(gittensor, "gittensor.json should have stale notes");
    const gittensorKinds = gittensor.stale_notes.map((n) => n.kind).sort();
    assert.ok(gittensorKinds.includes("dashboard"));
    assert.ok(gittensorKinds.includes("openapi"));
  });

  test("does not flag oneoneone.json's third-party subnet-api note", async () => {
    const report = await collectStaleGapNotes();
    const oneoneone = report.subnets.find((s) => s.file === "oneoneone.json");
    const flaggedKinds = (oneoneone?.stale_notes || []).map((n) => n.kind);
    assert.ok(!flaggedKinds.includes("subnet-api"));
  });
});
