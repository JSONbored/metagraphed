import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, repoRoot } from "./lib.mjs";

const templateRoot = path.join(repoRoot, ".github/ISSUE_TEMPLATE");
const interfaceTemplate = await fs.readFile(
  path.join(templateRoot, "add-update-subnet-interface.yml"),
  "utf8",
);
const statusTemplate = await fs.readFile(
  path.join(templateRoot, "report-endpoint-status-issue.yml"),
  "utf8",
);
const endpointTemplate = await fs.readFile(
  path.join(templateRoot, "add-update-endpoint-resource.yml"),
  "utf8",
);
const providerTemplate = await fs.readFile(
  path.join(templateRoot, "add-update-provider-profile.yml"),
  "utf8",
);
const pullRequestTemplate = await fs.readFile(
  path.join(repoRoot, ".github/pull_request_template.md"),
  "utf8",
);
const submissionGateDocs = await fs.readFile(
  path.join(repoRoot, "docs/submission-gate.md"),
  "utf8",
);
const candidateExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/direct-candidate.json"),
);
const providerExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/provider-profile.json"),
);
const statusReportExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/status-report.json"),
);
const errors = [];

checkIncludes(interfaceTemplate.toLowerCase(), "interface template", [
  "interface-submission",
  "metagraphed-under-review",
  "id: netuid",
  "id: kind",
  "id: url",
  "id: source_url",
  "id: auth_required",
  "schema-valid submissions are not auto-published",
  "metagraphed-import-approved",
  "read-only probes",
]);

for (const kind of [
  "archive",
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
  "sdk",
  "example",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
  "subtensor-rpc",
  "subtensor-wss",
]) {
  checkIncludes(interfaceTemplate, "interface template", [`- ${kind}`]);
}

checkIncludes(statusTemplate, "status template", [
  "status-report",
  "metagraphed-under-review",
  "id: netuid",
  "id: surface_id",
  "id: issue_type",
  "unsafe-or-private",
  "This report does not include secrets",
  "observed health is generated only by Metagraphed probes",
]);

checkIncludes(endpointTemplate, "endpoint resource template", [
  "endpoint-submission",
  "metagraphed-under-review",
  "id: netuid",
  "id: layer",
  "id: kind",
  "id: url",
  "id: source_url",
  "id: provider",
  "id: auth_required",
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
  "subnet-api",
  "openapi",
  "sse",
  "data-artifact",
  "pool eligibility are probe-derived only",
]);

checkIncludes(providerTemplate, "provider profile template", [
  "provider-submission",
  "metagraphed-under-review",
  "id: provider_slug",
  "id: provider_name",
  "id: provider_kind",
  "id: website_url",
  "id: github_url",
  "id: contact_url",
  "provider approval is required before endpoints can become pool-eligible",
]);

checkIncludes(pullRequestTemplate, "pull request template", [
  "registry/candidates/community/*.json",
  "npm run submission:pr",
]);

checkIncludes(submissionGateDocs, "submission gate docs", [
  "submit_pr",
  "fix_required",
  "route_away",
  "manual_review",
  "metagraphed-under-review",
  "metagraphed-manual-review",
  "metagraphed-closed-by-gate",
  "metagraphed-merged-by-gate",
  "metagraphed-import-approved",
  "<!-- metagraphed-submission-gate -->",
  "Discord Notifications",
  "DISCORD_SUBMISSION_WEBHOOK_URL",
  "last_notification_key",
  "merged",
  "closed",
  "manual-review",
  "retry-exhausted",
  "route_away",
]);

checkExampleCandidate(candidateExample);
checkExampleProvider(providerExample);
checkExampleStatusReport(statusReportExample);

if (errors.length > 0) {
  console.error(`Intake validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Issue intake templates passed validation.");

function checkIncludes(content, label, needles) {
  for (const needle of needles) {
    if (!content.includes(needle)) {
      errors.push(`${label}: missing ${needle}`);
    }
  }
}

function checkExampleCandidate(document) {
  const candidate = document?.candidates?.[0];
  if (document?.schema_version !== 1 || !candidate) {
    errors.push(
      "direct candidate example: missing schema_version or candidate",
    );
    return;
  }
  for (const field of [
    "id",
    "netuid",
    "kind",
    "url",
    "source_url",
    "provider",
    "public_safe",
  ]) {
    if (candidate[field] === undefined || candidate[field] === "") {
      errors.push(`direct candidate example: missing ${field}`);
    }
  }
}

function checkExampleProvider(provider) {
  for (const field of [
    "schema_version",
    "id",
    "name",
    "kind",
    "website_url",
    "authority",
  ]) {
    if (provider?.[field] === undefined || provider?.[field] === "") {
      errors.push(`provider example: missing ${field}`);
    }
  }
}

function checkExampleStatusReport(report) {
  if (report?.affects_observed_health !== false) {
    errors.push(
      "status report example: affects_observed_health must remain false",
    );
  }
  for (const field of ["schema_version", "netuid", "surface", "issue_type"]) {
    if (report?.[field] === undefined || report?.[field] === "") {
      errors.push(`status report example: missing ${field}`);
    }
  }
}
