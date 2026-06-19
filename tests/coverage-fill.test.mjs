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
import {
  extractSingleProvider,
  validateCandidateForSubmission,
  validateProviderForSubmission,
} from "../scripts/submission-policy.mjs";

const native = {
  subnets: [
    { netuid: 7, name: "Allways" },
    { netuid: 74, name: "Gittensor" },
  ],
};
const providers = [{ id: "allways" }, { id: "gittensor" }];

const baseCandidate = {
  schema_version: 1,
  id: "candidate-one",
  netuid: 7,
  state: "schema-valid",
  name: "Candidate one",
  kind: "docs",
  url: "https://docs.all-ways.io/path",
  source_url: "https://docs.all-ways.io/source",
  source_type: "community-pr-intake",
  source_tier: "community-docs",
  confidence: "medium",
  provider: "allways",
  auth_required: false,
  public_safe: true,
};

const validSubmissionDocument = {
  submission: {
    submitted_by: "jsonbored",
    submitted_by_url: "https://github.com/jsonbored",
  },
};

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

describe("submission-policy provider extraction and validation", () => {
  test("extractSingleProvider rejects non-object documents", () => {
    assert.deepEqual(extractSingleProvider(null), {
      provider: null,
      errors: [
        {
          category: "unsupported-shape",
          message: "provider submission document must be a JSON object",
        },
      ],
    });
    assert.equal(extractSingleProvider("string").errors.length, 1);
  });

  test("extractSingleProvider flags bad schema_version and missing provider", () => {
    const extracted = extractSingleProvider({
      schema_version: 2,
      provider: null,
    });
    assert.equal(extracted.provider, null);
    assert.equal(extracted.errors.length, 2);
    assert.equal(
      extracted.errors.some((error) =>
        error.message.includes("schema_version must be 1"),
      ),
      true,
    );
    assert.equal(
      extracted.errors.some((error) =>
        error.message.includes("must include provider"),
      ),
      true,
    );
  });

  test("extractSingleProvider returns a well-formed provider", () => {
    const extracted = extractSingleProvider({
      schema_version: 1,
      provider: { id: "example-operator" },
    });
    assert.equal(extracted.errors.length, 0);
    assert.deepEqual(extracted.provider, { id: "example-operator" });
  });

  test("validateProviderForSubmission requires a provider object", () => {
    const result = validateProviderForSubmission({
      provider: null,
      providers,
    });
    assert.equal(result.errors[0].category, "unsupported-shape");
    assert.equal(result.errors[0].message, "provider is required");
    assert.deepEqual(result.manual_reasons, [
      "provider profile submissions require review",
    ]);
  });

  test("validateProviderForSubmission flags every malformed provider field", () => {
    const result = validateProviderForSubmission({
      provider: {
        schema_version: 2,
        id: "Bad ID",
        name: "   ",
        kind: "made-up",
        website_url: "http://127.0.0.1",
        docs_url: "http://10.0.0.1",
        github_url: "http://169.254.169.254",
        team_url: "http://192.168.0.1",
        contact_url: "ftp://example.com",
        social: { x: "http://169.254.169.254/latest/meta-data" },
        authority: "official",
        notes: "legacy notes",
      },
      document: { submission: {} },
      submitter: null,
      providers,
    });
    const messages = result.errors.map((error) => error.message);
    assert.equal(messages.includes("provider schema_version must be 1"), true);
    assert.equal(
      messages.includes("provider id must be a lowercase slug"),
      true,
    );
    assert.equal(messages.includes("provider name is required"), true);
    assert.equal(messages.includes("provider kind is unsupported"), true);
    assert.equal(
      messages.includes("provider website_url is missing, invalid, or unsafe"),
      true,
    );
    assert.equal(
      messages.includes("provider docs_url is invalid or unsafe"),
      true,
    );
    assert.equal(
      messages.includes("provider github_url is invalid or unsafe"),
      true,
    );
    assert.equal(
      messages.includes("provider team_url is invalid or unsafe"),
      true,
    );
    assert.equal(
      messages.includes("provider contact_url is invalid or unsafe"),
      true,
    );
    assert.equal(
      messages.includes("provider social.x is invalid or unsafe"),
      true,
    );
    assert.equal(
      messages.includes(
        "community provider submissions can only use community or provider-claimed authority",
      ),
      true,
    );
    assert.equal(
      messages.includes(
        "community provider submissions must use public_notes, not notes",
      ),
      true,
    );
  });

  test("validateProviderForSubmission warns on normalizable URLs and reviews existing providers", () => {
    const result = validateProviderForSubmission({
      provider: {
        schema_version: 1,
        id: "allways",
        name: "Allways",
        kind: "subnet-team",
        website_url: "https://all-ways.io/",
        docs_url: "docs.all-ways.io/path/",
        authority: "provider-claimed",
      },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      providers,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(
      result.warnings.some((warning) =>
        warning.includes("docs_url will be normalized"),
      ),
      true,
    );
    assert.equal(
      result.manual_reasons.includes(
        "existing provider profile updates require review",
      ),
      true,
    );
  });
});

describe("submission-policy candidate schema shape branches", () => {
  test("flags non-string text fields, source_type and verification shape", () => {
    const result = validateCandidateForSubmission({
      candidate: {
        ...baseCandidate,
        source_type: 7,
        rate_limit_notes: 5,
        review_notes: { not: "a string" },
        verification: ["not", "an", "object"],
      },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      native,
      providers,
    });
    const messages = result.errors.map((error) => error.message);
    assert.equal(
      messages.includes("candidate source_type must be a string"),
      true,
    );
    assert.equal(
      messages.includes("candidate rate_limit_notes must be a string"),
      true,
    );
    assert.equal(
      messages.includes("candidate review_notes must be a string"),
      true,
    );
    assert.equal(
      messages.includes("candidate verification must be an object"),
      true,
    );
  });

  test("flags a non-object structured rate_limit (#788)", () => {
    const result = validateCandidateForSubmission({
      candidate: { ...baseCandidate, rate_limit: 42 },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      native,
      providers,
    });
    assert.equal(
      result.errors.some(
        (error) => error.message === "candidate rate_limit must be an object",
      ),
      true,
    );
  });

  test("flags every malformed field inside a structured rate_limit (#788)", () => {
    const messagesFor = (rateLimit) =>
      validateCandidateForSubmission({
        candidate: { ...baseCandidate, rate_limit: rateLimit },
        document: validSubmissionDocument,
        submitter: "jsonbored",
        native,
        providers,
      }).errors.map((error) => error.message);

    // missing requests + window, unknown field, negative burst, bad scope,
    // non-string cost_notes.
    const a = messagesFor({
      burst: -1,
      scope: "sometimes",
      cost_notes: 9,
      nope: 1,
    });
    assert.ok(a.includes("candidate rate_limit.requests is required"));
    assert.ok(a.includes("candidate rate_limit.window is required"));
    assert.ok(a.includes("candidate rate_limit.nope is not allowed"));
    assert.ok(
      a.includes("candidate rate_limit.burst must be a non-negative integer"),
    );
    assert.ok(a.includes("candidate rate_limit.scope is unsupported"));
    assert.ok(a.includes("candidate rate_limit.cost_notes must be a string"));

    // negative requests + non-string window.
    const b = messagesFor({ requests: -5, window: 7 });
    assert.ok(
      b.includes(
        "candidate rate_limit.requests must be a non-negative integer",
      ),
    );
    assert.ok(b.includes("candidate rate_limit.window is required"));

    // a well-formed structured limit passes the rate_limit checks.
    const c = messagesFor({
      requests: 100,
      window: "60s",
      burst: 10,
      scope: "per-key",
      cost_notes: "5 credits per call",
    });
    assert.ok(
      !c.some((message) => message.startsWith("candidate rate_limit.")),
    );
  });

  test("flags malformed verification metadata inside a verification object", () => {
    const result = validateCandidateForSubmission({
      candidate: {
        ...baseCandidate,
        verification: {
          classification: "not-a-real-classification",
          verified_at: 12345,
        },
      },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      native,
      providers,
    });
    const messages = result.errors.map((error) => error.message);
    assert.equal(
      messages.includes("candidate verification classification is unsupported"),
      true,
    );
    assert.equal(
      messages.includes("candidate verification verified_at must be a string"),
      true,
    );
  });

  test("accepts a well-formed verification object", () => {
    const result = validateCandidateForSubmission({
      candidate: {
        ...baseCandidate,
        verification: {
          classification: "live",
          verified_at: "1970-01-01T00:00:00.000Z",
        },
      },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      native,
      providers,
    });
    assert.equal(
      result.errors.some((error) =>
        error.message.startsWith("candidate verification"),
      ),
      false,
    );
  });

  test("treats a null verification as absent", () => {
    const result = validateCandidateForSubmission({
      candidate: { ...baseCandidate, verification: null },
      document: validSubmissionDocument,
      submitter: "jsonbored",
      native,
      providers,
    });
    assert.equal(
      result.errors.some((error) =>
        error.message.startsWith("candidate verification"),
      ),
      false,
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
