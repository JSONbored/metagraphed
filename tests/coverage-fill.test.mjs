import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  artifactDirectoryPath,
  listJsonFiles,
  listJsonFilesRecursive,
  netuidFromEvidenceSubject,
  publishedAt,
  readArtifactJson,
  selectReviewableReadmeLinks,
} from "../scripts/lib.mjs";
import { schemaDetailArtifactRelativePath } from "../src/artifact-storage.mjs";

describe("artifact-storage schema detail guards", () => {
  test("rejects schema detail paths containing a backslash segment", () => {
    assert.equal(
      schemaDetailArtifactRelativePath("schemas/sn-7\\openapi.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schemas/a\\b.json"),
      null,
    );
  });
});

describe("lib evidence-subject and artifact helpers", () => {
  test("netuidFromEvidenceSubject parses subnet, sn-, and unknown subjects", () => {
    assert.equal(netuidFromEvidenceSubject("subnet:5"), 5);
    assert.equal(netuidFromEvidenceSubject("candidate:community-sn-42-x"), 42);
    assert.equal(netuidFromEvidenceSubject("provider:unscoped"), null);
    assert.equal(netuidFromEvidenceSubject(""), null);
    assert.equal(netuidFromEvidenceSubject(null), null);
  });

  test("readArtifactJson reads a committed dual-tier artifact", async () => {
    const contracts = await readArtifactJson("contracts.json");
    assert.equal(typeof contracts, "object");
    assert.equal(contracts.primary_domain, "api.metagraph.sh");
  });

  test("artifactDirectoryPath falls back to the public tree when unstaged", () => {
    const directory = artifactDirectoryPath("definitely-not-staged-xyz/");
    assert.equal(directory.includes("public/metagraph"), true);
    assert.equal(directory.endsWith("definitely-not-staged-xyz"), true);
  });

  test("publishedAt returns the configured publish timestamp", () => {
    const previous = process.env.METAGRAPH_PUBLISHED_AT;
    try {
      process.env.METAGRAPH_PUBLISHED_AT = "  2026-06-10T00:00:00.000Z  ";
      assert.equal(publishedAt(), "2026-06-10T00:00:00.000Z");
      process.env.METAGRAPH_PUBLISHED_AT = "   ";
      assert.equal(publishedAt(), null);
    } finally {
      if (previous === undefined) {
        delete process.env.METAGRAPH_PUBLISHED_AT;
      } else {
        process.env.METAGRAPH_PUBLISHED_AT = previous;
      }
    }
  });
});

describe("lib JSON directory listing error propagation", () => {
  test("listJsonFiles and listJsonFilesRecursive rethrow non-ENOENT errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "metagraphed-listerr-"));
    const filePath = path.join(dir, "not-a-directory.json");
    try {
      await writeFile(filePath, "{}", "utf8");
      // Reading a file as a directory raises ENOTDIR (not ENOENT), which must
      // propagate rather than being swallowed as "no files".
      await assert.rejects(listJsonFiles(filePath), (error) => {
        assert.equal(error.code, "ENOTDIR");
        return true;
      });
      await assert.rejects(listJsonFilesRecursive(filePath), (error) => {
        assert.equal(error.code, "ENOTDIR");
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lib README link selection limits", () => {
  test("respects per-kind caps and the overall link limit", () => {
    const links = [
      {
        classification: { kind: "website", label: "site" },
        label: "Example one",
        url: "https://exampleproject.ai/",
      },
      {
        classification: { kind: "website", label: "site" },
        label: "Example two",
        url: "https://app.exampleproject.ai/",
      },
      {
        classification: { kind: "docs", label: "docs" },
        label: "Example docs",
        url: "https://docs.exampleproject.ai/install",
      },
    ];

    const selected = selectReviewableReadmeLinks(links, {
      repo: { owner: "ExampleProject", repo: "subnet" },
    });
    // website kind cap is 1, so only the first website survives; docs adds one.
    assert.deepEqual(
      selected.map((link) => link.url),
      ["https://exampleproject.ai/", "https://docs.exampleproject.ai/install"],
    );

    const capped = selectReviewableReadmeLinks(
      [
        {
          classification: { kind: "docs", label: "docs" },
          label: "First docs",
          url: "https://docs.exampleproject.ai/a",
        },
        {
          classification: { kind: "website", label: "site" },
          label: "Site",
          url: "https://exampleproject.ai/",
        },
      ],
      { limit: 1, repo: { owner: "ExampleProject", repo: "subnet" } },
    );
    assert.equal(capped.length, 1);
    assert.equal(capped[0].url, "https://docs.exampleproject.ai/a");
  });
});
