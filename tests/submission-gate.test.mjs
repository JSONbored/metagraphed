import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
} from "../scripts/lib.mjs";
import {
  SUBMISSION_LABELS,
  buildIssueIntakeReport,
  buildPrSubmissionReport,
  classifyPrScope,
} from "../scripts/submission-policy.mjs";
import {
  buildNotificationKey,
  buildSubmissionDiscordPayload,
  sanitizeNotificationSummary,
  shouldNotifySubmissionDecision,
  truncate,
  validateDiscordWebhookUrl,
} from "../scripts/submission-notifications.mjs";

const validCandidateDocument = JSON.parse(
  readFileSync(
    "tests/fixtures/submissions/valid-direct-candidate.json",
    "utf8",
  ),
);
const validProviderDocument = JSON.parse(
  readFileSync(
    "docs/examples/submissions/direct-provider-profile.json",
    "utf8",
  ),
);
const native = await loadNativeSnapshot();
const providers = await loadProviders();
const subnets = await loadSubnets();

describe("Metagraphed submission gate policy", () => {
  test("routes normal backend PRs away from the UGC gate", () => {
    const report = buildPrSubmissionReport({
      changedFiles: ["scripts/build-artifacts.mjs", "tests/artifacts.test.mjs"],
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "route_away");
    assert.equal(report.next_action, "normal-review");
    assert.equal(report.blocking, false);
  });

  test("accepts a one-file direct candidate for private review", () => {
    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/allways-docs-example.json"],
      candidateDocument: validCandidateDocument,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "JSONbored",
    });

    assert.equal(report.public_state, "submit_pr");
    assert.equal(report.next_action, "private-review");
    assert.equal(report.private_review_required, true);
    assert.equal(report.blocking, false);
    assert.equal(report.candidate.id, "community-sn-7-docs-example");
  });

  test("blocks direct candidates with malformed schema metadata", () => {
    const document = structuredClone(validCandidateDocument);
    delete document.candidates[0].state;
    delete document.candidates[0].name;
    document.candidates[0].auth_required = "false";
    document.candidates[0].unexpected_extra_property = true;

    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/malformed-metadata.json"],
      candidateDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(report.blocking, true);
    assert.equal(report.errors.includes("candidate state is required"), true);
    assert.equal(report.errors.includes("candidate name is required"), true);
    assert.equal(
      report.errors.includes("candidate auth_required must be boolean"),
      true,
    );
    assert.equal(
      report.errors.includes(
        "candidate unexpected_extra_property is not allowed",
      ),
      true,
    );
  });

  test("blocks direct candidates that edit unrelated files", () => {
    const scope = classifyPrScope([
      "registry/candidates/community/allways-docs-example.json",
      "public/metagraph/subnets.json",
    ]);

    assert.equal(scope.scope, "direct-candidate");
    assert.equal(scope.errors.length, 1);
    assert.equal(scope.errors[0].category, "generated-artifact-tampering");
  });

  test("routes mixed direct candidate PRs through the UGC gate", () => {
    const tmp = mkdtempSync(join(tmpdir(), "metagraphed-route-"));
    try {
      const changedFiles = join(tmp, "changed-files.txt");
      writeFileSync(
        changedFiles,
        [
          "registry/candidates/community/allways-docs-example.json",
          "README.md",
        ].join("\n"),
      );

      const output = execFileSync(
        process.execPath,
        ["scripts/ci-validate-route.mjs", "--changed-files", changedFiles],
        { encoding: "utf8" },
      );
      const report = JSON.parse(output);

      assert.equal(report.mode, "ugc");
      assert.equal(report.scope, "direct-candidate");
      assert.deepEqual(
        report.errors.map((error) => error.category),
        ["generated-artifact-tampering"],
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  test("routes direct provider profile PRs to manual review", () => {
    const document = structuredClone(validProviderDocument);
    document.submission.submitted_by = "jsonbored";
    document.submission.submitted_by_url = "https://github.com/jsonbored";
    const report = buildPrSubmissionReport({
      changedFiles: ["registry/providers/community/example-operator.json"],
      providerDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "JSONbored",
    });

    assert.equal(report.public_state, "manual_review");
    assert.equal(report.next_action, "manual-review");
    assert.equal(report.private_review_required, true);
    assert.equal(report.blocking, false);
    assert.equal(
      report.direct_provider_file,
      "registry/providers/community/example-operator.json",
    );
    assert.equal(report.provider.id, "example-operator");
    assert.equal(
      report.manual_reasons.includes(
        "provider profile submissions require review",
      ),
      true,
    );
  });

  test("blocks unsafe direct provider profile PRs", () => {
    const document = structuredClone(validProviderDocument);
    document.submission.submitted_by = "jsonbored";
    document.submission.submitted_by_url = "https://github.com/jsonbored";
    document.provider.authority = "official";
    document.provider.website_url = "http://127.0.0.1";
    document.provider.notes = "github_pat_abcdefghijklmnopqrstuvwxyz123456";

    const report = buildPrSubmissionReport({
      changedFiles: ["registry/providers/community/unsafe-provider.json"],
      providerDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "JSONbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(report.blocking, true);
    assert.equal(
      report.errors.includes(
        "community provider submissions can only use community or provider-claimed authority",
      ),
      true,
    );
    assert.equal(
      report.errors.includes(
        "community provider submissions must use public_notes, not notes",
      ),
      true,
    );
    assert.equal(
      report.error_categories.includes("private-or-unsafe-url"),
      true,
    );
    assert.equal(
      report.error_categories.includes("secret-or-credential"),
      true,
    );
  });

  test("blocks mixed direct candidate and provider PRs", () => {
    const scope = classifyPrScope([
      "registry/candidates/community/allways-docs-example.json",
      "registry/providers/community/example-operator.json",
    ]);

    assert.equal(scope.scope, "direct-provider");
    assert.equal(scope.errors.length, 1);
    assert.equal(scope.errors[0].category, "unsupported-shape");
  });

  test("blocks unsafe candidate URLs", () => {
    const document = structuredClone(validCandidateDocument);
    document.candidates[0].url = "http://127.0.0.1:9944";
    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/bad-localhost.json"],
      candidateDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(report.blocking, true);
    assert.equal(
      report.error_categories.includes("private-or-unsafe-url"),
      true,
    );
  });

  test("blocks unsafe candidate provenance URLs", () => {
    const document = structuredClone(validCandidateDocument);
    document.candidates[0].source_urls = [
      "https://docs.all-ways.io/how-it-works.html",
      "http://169.254.169.254/latest/meta-data/",
    ];
    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/bad-provenance.json"],
      candidateDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(report.blocking, true);
    assert.equal(
      report.errors.includes("candidate source_urls[1] is invalid or unsafe"),
      true,
    );
    assert.equal(
      report.error_categories.includes("private-or-unsafe-url"),
      true,
    );
  });

  test("routes auth-required and base-layer endpoint claims to manual review", () => {
    const authDocument = structuredClone(validCandidateDocument);
    authDocument.candidates[0].auth_required = true;
    const authReport = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/auth-api.json"],
      candidateDocument: authDocument,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });
    assert.equal(authReport.public_state, "manual_review");

    const rpcDocument = structuredClone(validCandidateDocument);
    rpcDocument.candidates[0].kind = "subtensor-rpc";
    rpcDocument.candidates[0].url = "https://rpc.example.com";
    const rpcReport = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/rpc.json"],
      candidateDocument: rpcDocument,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });
    assert.equal(rpcReport.public_state, "manual_review");
  });

  test("blocks duplicate curated surfaces", () => {
    const allways = subnets.find((subnet) => subnet.netuid === 7);
    const duplicateSurface = allways.surfaces[0];
    const document = structuredClone(validCandidateDocument);
    Object.assign(document.candidates[0], {
      kind: duplicateSurface.kind,
      url: duplicateSurface.url,
    });

    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/duplicate.json"],
      candidateDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(report.terminal_recommendation, "close");
    assert.equal(report.error_categories.includes("duplicate"), true);
  });

  test("requires direct PR provenance to match the submitter", () => {
    const document = structuredClone(validCandidateDocument);
    document.submission.submitted_by = "someone-else";
    document.submission.submitted_by_url = "https://github.com/someone-else";
    const report = buildPrSubmissionReport({
      changedFiles: ["registry/candidates/community/provenance.json"],
      candidateDocument: document,
      native,
      providers,
      existingSubnets: subnets,
      submitter: "jsonbored",
    });

    assert.equal(report.public_state, "fix_required");
    assert.equal(
      report.errors.includes(
        "submission.submitted_by must match the PR author",
      ),
      true,
    );
  });

  test("rejects duplicate issue fields hidden in markdown", () => {
    const body = [
      "### Netuid",
      "7",
      "### Subnet name",
      "Allways",
      "### Interface kind",
      "docs",
      "### Public URL",
      "https://docs.all-ways.io/community-submission-example",
      "### Source URL",
      "https://docs.all-ways.io/how-it-works.html",
      "### Provider or team",
      "allways",
      "### Does this interface require authentication?",
      "no",
      "### Evidence",
      "<!--",
      "### Public URL",
      "https://phishing.example.net/login",
      "-->",
      "### Source URL",
      "https://evil.example.net/proof",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 43,
        title: "interface: hidden duplicate",
        user: { login: "jsonbored" },
        labels: [
          { name: SUBMISSION_LABELS.interfaceSubmission },
          { name: SUBMISSION_LABELS.importApproved },
        ],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.state, "schema-invalid");
    assert.equal(report.import_allowed, false);
    assert.equal(
      report.errors.includes("duplicate issue field heading: Source URL"),
      true,
    );
    assert.equal(report.candidate, null);
  });

  test("keeps issue approval explicit", () => {
    const body = [
      "### Netuid",
      "7",
      "### Subnet name",
      "Allways",
      "### Interface kind",
      "docs",
      "### Public URL",
      "https://docs.all-ways.io/community-submission-example",
      "### Source URL",
      "https://docs.all-ways.io/how-it-works.html",
      "### Provider or team",
      "allways",
      "### Does this interface require authentication?",
      "no",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 42,
        title: "interface: allways docs",
        user: { login: "jsonbored" },
        labels: [
          { name: SUBMISSION_LABELS.interfaceSubmission },
          { name: SUBMISSION_LABELS.importApproved },
        ],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.state, "schema-valid");
    assert.equal(report.public_state, "submit_pr");
    assert.equal(report.import_allowed, true);
    assert.equal(report.next_action, "open-import-pr");
  });

  test("routes provider profile issue submissions to manual review", () => {
    const body = [
      "### Provider slug",
      "allways",
      "### Provider name",
      "Allways",
      "### Provider kind",
      "subnet-team",
      "### Website URL",
      "https://all-ways.io",
      "### Docs URL",
      "https://docs.all-ways.io/how-it-works.html",
      "### GitHub org or repo URL",
      "https://github.com/Ent-Rho/allways-subnet",
      "### Public contact URL",
      "https://docs.all-ways.io/how-it-works.html",
      "### Public notes",
      "Public subnet team profile update.",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 50,
        title: "provider: allways",
        user: { login: "jsonbored" },
        labels: [{ name: SUBMISSION_LABELS.providerSubmission }],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.source, "github-provider-intake");
    assert.equal(report.state, "schema-valid");
    assert.equal(report.public_state, "manual_review");
    assert.equal(report.provider.id, "allways");
    assert.equal(report.provider.authority, "provider-claimed");
    assert.equal(
      report.provider.docs_url,
      "https://docs.all-ways.io/how-it-works.html",
    );
    assert.equal(
      report.provider.github_url,
      "https://github.com/Ent-Rho/allways-subnet",
    );
    assert.equal(report.next_action, "manual-review");
  });

  test("rejects malformed provider profile issue submissions", () => {
    const body = [
      "### Provider slug",
      "",
      "### Provider name",
      "",
      "### Provider kind",
      "paid-promo",
      "### Website URL",
      "http://127.0.0.1",
      "### Docs URL",
      "http://10.0.0.5/docs",
      "### GitHub org or repo URL",
      "not a url",
      "### Public contact URL",
      "http://169.254.169.254/latest/meta-data/",
      "### Public notes",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456 should fail",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 51,
        title: "provider: unsafe",
        user: { login: "jsonbored" },
        labels: [{ name: SUBMISSION_LABELS.providerSubmission }],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.source, "github-provider-intake");
    assert.equal(report.state, "schema-invalid");
    assert.equal(report.public_state, "fix_required");
    assert.equal(report.provider, null);
    assert.equal(report.errors.includes("provider kind is unsupported"), true);
    assert.equal(
      report.errors.includes("website URL is missing, invalid, or unsafe"),
      true,
    );
    assert.equal(report.errors.includes("docs URL is invalid or unsafe"), true);
    assert.equal(
      report.errors.includes("GitHub URL is invalid or unsafe"),
      true,
    );
    assert.equal(
      report.errors.includes("public contact URL is invalid or unsafe"),
      true,
    );
    assert.equal(
      report.errors.includes(
        "submission appears to include wallet, PAT, token, or private credential material",
      ),
      true,
    );
  });

  test("routes endpoint status reports without mutating observed health", () => {
    const body = [
      "### Netuid",
      "7",
      "### Surface ID or URL",
      "https://api.all-ways.io/health",
      "### Issue type",
      "stale",
      "### Evidence",
      "Public health response looked stale during a read-only check.",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 52,
        title: "status: allways api stale",
        user: { login: "jsonbored" },
        labels: [{ name: SUBMISSION_LABELS.statusReport }],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.source, "github-status-report-intake");
    assert.equal(report.state, "schema-valid");
    assert.equal(report.public_state, "manual_review");
    assert.equal(report.report.affects_observed_health, false);
    assert.equal(report.report.next_action, "review-or-reprobe");
  });

  test("rejects malformed endpoint status reports", () => {
    const body = [
      "### Netuid",
      "999",
      "### Surface ID or URL",
      "http://127.0.0.1:9944",
      "### Issue type",
      "please-rank-this",
      "### Evidence",
      "",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 53,
        title: "status: unsafe",
        user: { login: "jsonbored" },
        labels: [{ name: SUBMISSION_LABELS.statusReport }],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.source, "github-status-report-intake");
    assert.equal(report.state, "schema-invalid");
    assert.equal(report.public_state, "fix_required");
    assert.equal(report.report, null);
    assert.equal(
      report.errors.includes("netuid must be an active Finney netuid"),
      true,
    );
    assert.equal(
      report.errors.includes("surface URL is invalid or unsafe"),
      true,
    );
    assert.equal(report.errors.includes("issue type is unsupported"), true);
    assert.equal(report.errors.includes("public evidence is required"), true);
  });

  test("rejects blank status surfaces and credential-like evidence", () => {
    const body = [
      "### Netuid",
      "7",
      "### Surface ID or URL",
      "",
      "### Issue type",
      "down",
      "### Evidence",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456 token should not pass.",
    ].join("\n\n");
    const report = buildIssueIntakeReport({
      issue: {
        number: 54,
        title: "status: secret",
        user: { login: "jsonbored" },
        labels: [{ name: SUBMISSION_LABELS.statusReport }],
        body,
      },
      native,
      providers,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    assert.equal(report.state, "schema-invalid");
    assert.equal(report.errors.includes("surface ID or URL is required"), true);
    assert.equal(
      report.errors.includes(
        "submission appears to include wallet, PAT, token, or private credential material",
      ),
      true,
    );
  });

  test("notifies only terminal UGC decisions", () => {
    assert.equal(
      shouldNotifySubmissionDecision({
        public_state: "submit_pr",
        verdict: "merged",
      }),
      false,
    );
    assert.equal(
      shouldNotifySubmissionDecision({
        public_state: "route_away",
        verdict: "merged",
      }),
      false,
    );
    assert.equal(
      shouldNotifySubmissionDecision({
        public_state: "manual_review",
        verdict: "manual-review",
      }),
      true,
    );
    assert.equal(
      shouldNotifySubmissionDecision({
        public_state: "done",
        verdict: "retry-exhausted",
      }),
      true,
    );
  });

  test("formats terminal Discord payloads without private marker or secrets", () => {
    const payload = buildSubmissionDiscordPayload({
      verdict: "closed",
      status: "closed",
      pr_number: 42,
      pr_url: "https://github.com/JSONbored/metagraphed/pull/42",
      title: "feat(intake): add Allways docs",
      submitter: "jsonbored",
      candidate: {
        netuid: 7,
        kind: "docs",
        source_url: "https://docs.all-ways.io/how-it-works.html",
      },
      summary: [
        "<!-- metagraphed-submission-gate -->",
        "Summary:",
        "- Closed because the submitted surface duplicates an existing entry.",
        "- github_pat_should-not-leak-even-in-test-fixtures",
      ].join("\n"),
      now: "1970-01-01T00:00:00.000Z",
    });

    const serialized = JSON.stringify(payload);
    assert.equal(payload.username, "Metagraphed Maintainer Agent");
    assert.equal(payload.embeds[0].title, "#42 closed · Allways docs");
    assert.equal(payload.embeds[0].color, 0xda3633);
    assert.equal(payload.embeds[0].timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(serialized.includes("metagraphed-submission-gate"), false);
    assert.equal(serialized.includes("github_pat_should"), false);
    assert.equal(serialized.includes("private prompt"), false);
  });

  test("sanitizes Discord payload fields beyond the summary", () => {
    const payload = buildSubmissionDiscordPayload({
      verdict: "closed",
      status: "closed",
      pr_number: 77,
      pr_url:
        "https://github.com/JSONbored/metagraphed/pull/77?token=ghp_should_not_leak",
      title:
        "feat(intake): https://discord.com/api/webhooks/redacted github_pat_should_not_leak",
      submitter: "wallet private key should not leak",
      candidate: {
        netuid: 7,
        kind: "docs",
        source_url: "https://discord.com/api/webhooks/redacted",
      },
      summary: [
        "Summary:",
        "- Public review completed.",
        "- private threshold github_pat_should_not_leak",
      ].join("\n"),
      now: "1970-01-01T00:00:00.000Z",
    });

    const serialized = JSON.stringify(payload);
    assert.equal(payload.embeds[0].title, "#77 closed · SN7 docs");
    assert.equal(payload.embeds[0].url, undefined);
    assert.equal(
      payload.embeds[0].fields.find((field) => field.name === "Source").value,
      "n/a",
    );
    assert.equal(
      payload.embeds[0].fields.some((field) => field.name === "GitHub"),
      false,
    );
    assert.equal(
      payload.embeds[0].fields.find((field) => field.name === "Submitter")
        .value,
      "n/a",
    );
    assert.equal(serialized.includes("discord.com/api/webhooks"), false);
    assert.equal(serialized.includes("github_pat"), false);
    assert.equal(serialized.includes("ghp_should"), false);
    assert.equal(serialized.includes("private threshold"), false);
    assert.equal(serialized.includes("private key"), false);
  });

  test("sanitizes notification summaries and preserves code points", () => {
    assert.equal(
      sanitizeNotificationSummary(
        [
          "Summary:",
          "- Discord webhook https://discord.com/api/webhooks/redacted",
          "- Private prompt score must never be exposed.",
          "- Manual review needed because source evidence conflicts.",
        ].join("\n"),
      ),
      "Manual review needed because source evidence conflicts.",
    );

    const capped = truncate(`${"a".repeat(12)}😀tail`, 14);
    assert.equal(capped.includes("�"), false);
    assert.doesNotThrow(() => encodeURIComponent(capped));
  });

  test("builds notification keys from target revision and terminal verdict", () => {
    assert.equal(
      buildNotificationKey({
        target: {
          kind: "pull_request",
          repo: "JSONbored/metagraphed",
          number: 42,
          head_sha: "abc123",
        },
        decision: {
          status: "merged",
          verdict: "merged",
        },
      }),
      "pull_request:JSONbored/metagraphed:42:abc123:merged:merged",
    );

    assert.equal(
      buildNotificationKey({
        target: {
          kind: "issue",
          repo: "JSONbored/metagraphed",
          number: 7,
          issue_revision: "edited-1",
        },
        decision: {
          status: "manual",
          verdict: "manual-review",
        },
      }),
      "issue:JSONbored/metagraphed:7:edited-1:manual:manual-review",
    );

    assert.equal(
      buildNotificationKey({}),
      "submission:unknown-repo:0:unknown-revision:terminal:unknown-verdict",
    );
  });

  test("validates Discord webhook URLs and skips non-terminal payloads", () => {
    assert.equal(buildSubmissionDiscordPayload({ verdict: "closed" }), null);
    assert.equal(
      buildSubmissionDiscordPayload({
        public_state: "fix_required",
        verdict: "closed",
      }),
      null,
    );
    assert.equal(validateDiscordWebhookUrl("not a url"), null);
    assert.equal(
      validateDiscordWebhookUrl("http://discord.com/api/webhooks/1/token"),
      null,
    );
    assert.equal(
      validateDiscordWebhookUrl("https://example.com/api/webhooks/1/token"),
      null,
    );
    assert.equal(
      validateDiscordWebhookUrl("https://discord.com/api/webhooks/redacted"),
      null,
    );

    const webhook = [
      "https://discord.com/api/webhooks",
      "123456789012345678",
      "abcdefghijklmnopqrstuvwxyzABCDEF",
    ].join("/");
    assert.equal(validateDiscordWebhookUrl(webhook), webhook);
  });

  test("builds compact issue payloads with fallback descriptions", () => {
    const payload = buildSubmissionDiscordPayload({
      public_state: "terminal",
      verdict: "retry-exhausted",
      status: "error_retryable",
      issue_number: 55,
      issue_url: "https://github.com/JSONbored/metagraphed/issues/55",
      submitter: "jsonbored",
      netuid: 12,
      kind: "openapi",
      source_url: "https://docs.example.com/openapi.json",
      summary: "",
      now: "invalid-date",
    });

    assert.equal(payload.embeds[0].title, "#55 needs attention · SN12 openapi");
    assert.equal(payload.embeds[0].color, 0xfb8500);
    assert.equal(
      payload.embeds[0].description,
      "Metagraphed needs attention this openapi submission for SN12.",
    );
    assert.equal(
      Number.isNaN(new Date(payload.embeds[0].timestamp).getTime()),
      false,
    );
    assert.equal(
      payload.embeds[0].fields.some(
        (field) =>
          field.name === "Source" &&
          field.value === "https://docs.example.com/openapi.json",
      ),
      true,
    );
  });

  test("handles notification summary edge cases", () => {
    const datePayload = buildSubmissionDiscordPayload({
      public_state: "terminal",
      verdict: "merged",
      status: "merged",
      pr_number: 1,
      title: "",
      candidate: {
        netuid: 7,
        kind: "docs",
      },
      summary: "Useful public source confirmed.",
      now: new Date("1970-01-01T00:00:00.000Z"),
    });

    assert.equal(datePayload.embeds[0].title, "#1 merged · SN7 docs");
    assert.equal(datePayload.embeds[0].timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(
      sanitizeNotificationSummary(
        "prefix <!-- unterminated comment\nsource review:\nPublic evidence OK.",
      ),
      "prefix Public evidence OK.",
    );
  });
});
