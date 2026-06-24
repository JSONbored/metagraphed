import { promises as fs } from "node:fs";
import path from "node:path";
import { listJsonFilesRecursive, readJson, repoRoot } from "./lib.mjs";

const templateRoot = path.join(repoRoot, ".github/ISSUE_TEMPLATE");
const surfaceTemplate = await fs.readFile(
  path.join(templateRoot, "add-subnet-surface.yml"),
  "utf8",
);
const statusTemplate = await fs.readFile(
  path.join(templateRoot, "report-endpoint-status-issue.yml"),
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
const prTemplateRoot = path.join(repoRoot, ".github/PULL_REQUEST_TEMPLATE");
const surfacePrTemplate = await fs.readFile(
  path.join(prTemplateRoot, "surface.md"),
  "utf8",
);
const providerProfileTemplate = await fs.readFile(
  path.join(prTemplateRoot, "provider-profile.md"),
  "utf8",
);
const backendCodeTemplate = await fs.readFile(
  path.join(prTemplateRoot, "backend-code.md"),
  "utf8",
);
const docsOnlyTemplate = await fs.readFile(
  path.join(prTemplateRoot, "docs-only.md"),
  "utf8",
);
const submissionGateDocs = await fs.readFile(
  path.join(repoRoot, "docs/submission-gate.md"),
  "utf8",
);
const providerExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/provider-profile.json"),
);
const directProviderExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/direct-provider-profile.json"),
);
const statusReportExample = await readJson(
  path.join(repoRoot, "docs/examples/submissions/status-report.json"),
);
const errors = [];

// The per-surface community-candidate intake lane is retired — surfaces now live
// in ONE file per subnet (registry/subnets/<slug>.json), added with
// `npm run surface:add`. Reject any recreation of the candidate dir so the
// migrated-away one-file-per-surface farm can't reopen. Runs in both the UGC and
// full CI lanes (validate:intake is on both), so a candidate file is always caught.
try {
  const retiredDir = path.join(repoRoot, "registry/candidates/community");
  const retiredFiles = (await listJsonFilesRecursive(retiredDir)).map((file) =>
    path.relative(retiredDir, file),
  );
  if (retiredFiles.length > 0) {
    errors.push(
      `registry/candidates/community/ is retired (${retiredFiles.length} file(s): ${retiredFiles.join(", ")}). ` +
        "Add surfaces to registry/subnets/<slug>.json with `npm run surface:add` instead.",
    );
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

checkIncludes(surfaceTemplate.toLowerCase(), "surface template", [
  "surface-submission",
  "metagraphed-under-review",
  "id: netuid",
  "id: kind",
  "label: surface kind",
  "id: url",
  "id: source_url",
  "id: provider",
  "label: provider slug",
  "id: auth_required",
  "label: does this surface require authentication?",
  "registry/subnets/<slug>.json",
  "npm run surface:add",
  "read-only probes",
]);

for (const kind of [
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
]) {
  checkIncludes(surfaceTemplate, "surface template", [`- ${kind}`]);
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

checkIncludes(pullRequestTemplate, "pull request template router", [
  "?template=surface.md",
  "?template=provider-profile.md",
  "?template=backend-code.md",
  "?template=docs-only.md",
  "registry/subnets/<slug>.json",
  "registry/providers/*.json",
  "generated `public/metagraph/**`",
]);

checkIncludes(surfacePrTemplate, "surface PR template", [
  "registry/subnets/<slug>.json",
  "npm run surface:add",
  "review.state",
  "Base-layer RPC/WSS/archive",
  "npm run validate:surface",
  "npm run scan:public-safety",
  "Closes #",
]);

checkIncludes(providerProfileTemplate, "provider profile PR template", [
  "registry/providers/*.json",
  "npm run provider:new",
  "docs/examples/submissions/direct-provider-profile.json",
  "manual/private review",
  "pool-eligible",
  "npm run submission:pr",
  "npm run validate:intake",
  "npm run scan:public-safety",
]);

checkIncludes(backendCodeTemplate, "backend code PR template", [
  "npm run check",
  "npm run validate:api",
  "npm run validate:openapi",
  "npm run test:coverage",
  "R2-only/high-churn detail artifacts are not committed",
]);

checkIncludes(docsOnlyTemplate, "docs-only PR template", [
  "docs/templates only",
  "No generated `public/metagraph/**` artifacts",
  "npm run validate:docs",
  "npm run validate:intake",
  "git diff --check",
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
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "METAGRAPH_GATE_ALLOW_GITHUB_TOKEN_FALLBACK",
  "github_write_mode",
  "production_ready",
  "production_blockers",
  "npm run submission-gate:health",
  "last_notification_key",
  "merged",
  "closed",
  "manual-review",
  "retry-exhausted",
  "route_away",
]);

checkExampleProvider(providerExample);
checkExampleProviderSubmission(directProviderExample);
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

function checkExampleProviderSubmission(document) {
  if (document?.schema_version !== 1 || !document?.provider) {
    errors.push(
      "direct provider profile example: missing schema_version or provider",
    );
    return;
  }
  if (
    document?.submission?.submitted_by_url !==
    `https://github.com/${document?.submission?.submitted_by}`
  ) {
    errors.push(
      "direct provider profile example: submitted_by_url must match submitted_by",
    );
  }
  checkExampleProvider(document.provider);
  if (
    !["community", "provider-claimed"].includes(document.provider.authority)
  ) {
    errors.push(
      "direct provider profile example: authority must be community or provider-claimed",
    );
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
