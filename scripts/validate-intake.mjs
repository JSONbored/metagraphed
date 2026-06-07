import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const templateRoot = path.join(repoRoot, ".github/ISSUE_TEMPLATE");
const interfaceTemplate = await fs.readFile(
  path.join(templateRoot, "add-update-subnet-interface.yml"),
  "utf8",
);
const statusTemplate = await fs.readFile(
  path.join(templateRoot, "report-endpoint-status-issue.yml"),
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
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
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
