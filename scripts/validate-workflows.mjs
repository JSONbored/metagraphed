import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const workflowRoot = path.join(repoRoot, ".github/workflows");
const workflows = (await fs.readdir(workflowRoot))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const errors = [];

for (const workflow of workflows) {
  const content = await fs.readFile(path.join(workflowRoot, workflow), "utf8");
  check(
    content.includes("permissions:"),
    workflow,
    "missing top-level permissions",
  );
  check(
    content.includes("concurrency:"),
    workflow,
    "missing concurrency guard",
  );
  check(
    !/\bcontinue-on-error:\s*true\b/.test(content),
    workflow,
    "must not mask failures with continue-on-error",
  );
  check(
    !/\$\{\{\s*github\.event\.(issue|comment|pull_request)\.(body|title)/.test(
      content,
    ),
    workflow,
    "untrusted GitHub event text is interpolated directly",
  );
  check(
    !/run:\s*\|[\s\S]*<<EOF/.test(content),
    workflow,
    "predictable heredoc delimiter in run block",
  );
  check(
    !/discord(?:app)?\.com\/api\/webhooks|DISCORD_SUBMISSION_WEBHOOK_URL/i.test(
      content,
    ),
    workflow,
    "Discord notifications must be sent by the private Cloudflare gate, not GitHub Actions",
  );
  check(
    /uses:\s+actions\/checkout@/.test(content),
    workflow,
    "missing checkout action",
  );
  for (const match of content.matchAll(/uses:\s+([^\s#]+)/g)) {
    const actionRef = match[1].replace(/^['"]|['"]$/g, "");
    if (actionRef.startsWith("./") || actionRef.startsWith("docker://")) {
      continue;
    }
    check(
      /@[a-f0-9]{40}$/i.test(actionRef),
      workflow,
      `action ref must be pinned to a full commit SHA: ${actionRef}`,
    );
  }
  if (workflow === "intake-validation.yml") {
    check(
      content.includes(
        "contains(github.event.issue.labels.*.name, 'interface-submission')",
      ),
      workflow,
      "intake must be exact-label gated",
    );
  }
  if (workflow === "intake-import-pr.yml") {
    check(
      content.includes(
        "contains(github.event.issue.labels.*.name, 'interface-submission')",
      ),
      workflow,
      "intake import must require interface-submission label",
    );
    check(
      content.includes(
        "contains(github.event.issue.labels.*.name, 'metagraphed-import-approved')",
      ),
      workflow,
      "intake import must require maintainer approval label",
    );
    check(
      content.includes("peter-evans/create-pull-request@"),
      workflow,
      "intake import must open a PR instead of direct-publishing",
    );
    check(
      content.includes("npm run intake:import"),
      workflow,
      "intake import must use the checked-in import script",
    );
    check(
      !content.includes("--issue-json issue.json") &&
        !content.includes("--out intake-report.json"),
      workflow,
      "intake import must keep transient issue and report files outside the repository workspace",
    );
    check(
      content.includes("add-paths:") &&
        content.includes("registry/**") &&
        content.includes("public/**") &&
        content.includes("dist/metagraph-r2/**") &&
        content.includes("schemas/**") &&
        content.includes("generated/**"),
      workflow,
      "intake import pull request must allowlist generated registry artifact paths",
    );
  }
  if (workflow === "submission-gate.yml") {
    check(
      content.includes("metagraphed-submission-gate:"),
      workflow,
      "submission gate workflow must expose the metagraphed-submission-gate job",
    );
    check(
      content.includes("Checkout trusted base worktree") &&
        content.includes("path: trusted") &&
        content.includes(
          "ref: ${{ github.event.pull_request.base.sha || github.sha }}",
        ),
      workflow,
      "submission gate workflow must checkout trusted base code",
    );
    check(
      content.includes("working-directory: trusted") &&
        content.includes("node scripts/submission-pr.mjs") &&
        content.includes("--input-root ../pr"),
      workflow,
      "submission gate workflow must run trusted classifier against PR input",
    );
    check(
      !content.includes("npm run submission:pr"),
      workflow,
      "submission gate workflow must not execute PR-controlled npm scripts",
    );
    check(
      !content.includes("contents: write") &&
        !content.includes("pull-requests: write"),
      workflow,
      "public submission gate workflow must not publish or merge",
    );
  }
  if (
    ["validate.yml", "sync-subnets.yml", "publish-cloudflare.yml"].includes(
      workflow,
    )
  ) {
    const usesRefreshPipeline = content.includes("npm run pipeline:refresh");
    check(
      usesRefreshPipeline || content.includes("npm run validate:docs"),
      workflow,
      "workflow must validate public documentation contracts",
    );
    check(
      usesRefreshPipeline ||
        content.includes("npm run validate:private-boundary"),
      workflow,
      "workflow must validate private reviewer and notification boundaries",
    );
  }
  if (workflow === "publish-cloudflare.yml") {
    check(
      !content.includes("npm run pipeline:refresh"),
      workflow,
      "publish workflow must not refresh live registry data during deployment",
    );
    const refreshJob = workflowJobBlock(content, "refresh");
    const publishJob = workflowJobBlock(content, "publish");
    check(
      !publishJob.includes('METAGRAPH_WRITE_PROBE_RESULTS: "1"'),
      workflow,
      "publish job must not write live probe results during deployment",
    );
    check(
      refreshJob.includes('METAGRAPH_PRODUCTION_BUILD: "1"') &&
        refreshJob.includes("npm run build") &&
        refreshJob.includes("npm run r2:manifest"),
      workflow,
      "publish workflow refresh job must prepare R2 artifacts with the production probe-health build path",
    );
    check(
      /\brefresh:\n[\s\S]*\bpublish:\n[\s\S]*needs:\s+refresh/.test(content),
      workflow,
      "publish workflow must isolate refresh tooling from Cloudflare publishing secrets",
    );
    check(
      !/python3\s+-m\s+pip\s+install[\s\S]*\buv==/.test(content),
      workflow,
      "publish workflow must not install uv from PyPI in a secret-bearing path",
    );
    check(
      content.includes("astral-sh/setup-uv@") &&
        content.includes("cloudflare-publish-artifacts"),
      workflow,
      "publish workflow must pass refreshed artifacts from the isolated refresh job",
    );
    check(
      content.includes('METAGRAPH_R2_UPLOAD_HISTORY: "1"'),
      workflow,
      "publish workflow must upload versioned R2 history objects",
    );
    check(
      content.includes("publish_mode:") &&
        content.includes("Use workflow_dispatch publish_mode=dry-run"),
      workflow,
      "publish workflow must expose an explicit validation-only dry-run mode",
    );
    check(
      content.includes(
        "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for main publish runs",
      ),
      workflow,
      "publish workflow must fail closed when Cloudflare publishing secrets are missing",
    );
    check(
      refreshJob.includes('METAGRAPH_PRODUCTION_BUILD: "1"'),
      workflow,
      "publish workflow refresh job must explicitly use the production build path",
    );
    check(
      publishJob.includes('METAGRAPH_REQUIRE_PROBE_HEALTH: "1"'),
      workflow,
      "publish workflow publish job must explicitly require probe-derived health",
    );
    check(
      content.includes("steps.cloudflare-secrets.outputs.dry_run != 'true'"),
      workflow,
      "publish workflow must skip deploy/upload steps only in explicit dry-run mode",
    );
  }
}

if (errors.length > 0) {
  console.error(`Workflow validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${workflows.length} workflow file(s).`);

function check(condition, workflow, message) {
  if (!condition) {
    errors.push(`${workflow}: ${message}`);
  }
}

function workflowJobBlock(content, jobName) {
  const match = content.match(
    new RegExp(
      String.raw`^  ${escapeRegExp(jobName)}:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))`,
      "m",
    ),
  );
  return match?.[0] || "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
