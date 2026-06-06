import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const validCandidateDocument = JSON.parse(
  readFileSync(
    "tests/fixtures/submissions/valid-direct-candidate.json",
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

  test("blocks direct candidates that edit unrelated files", () => {
    const scope = classifyPrScope([
      "registry/candidates/community/allways-docs-example.json",
      "public/metagraph/subnets.json",
    ]);

    assert.equal(scope.scope, "direct-candidate");
    assert.equal(scope.errors.length, 1);
    assert.equal(scope.errors[0].category, "generated-artifact-tampering");
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
});
