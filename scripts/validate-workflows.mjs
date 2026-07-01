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
  if (workflow === "validate.yml") {
    // There is NO reduced "ugc" lane to forge — every PR runs the full
    // validation. The only PR-derived input is the deletion-filtered submitted-
    // file list, computed inline in this trusted workflow (a checkout-local
    // action could be PR-controlled) and consumed only to diff-scope the
    // reproducible-artifact verifier.
    check(
      !content.includes("uses: ./.github/actions/classify-validation-route"),
      workflow,
      "validate workflow must not route CI through PR-controlled local actions",
    );
    check(
      content.includes("git diff --name-only") &&
        content.includes("--diff-filter=d") &&
        content.includes("> submitted-artifact-files.txt") &&
        !content.includes("PY_ROUTE") &&
        !content.includes("mode=ugc"),
      workflow,
      "validate workflow must compute the submitted-artifact diff inline and run no reduced ugc lane",
    );
    check(
      content.includes("--changed-files submitted-artifact-files.txt"),
      workflow,
      "validate workflow must verify submitted artifacts from the deletion-filtered list",
    );
    check(
      content.includes(
        "git status --porcelain --untracked-files=all -- public/",
      ) &&
        content.includes("Committed derived artifacts under public/ are stale"),
      workflow,
      "validate workflow must detect rebuilt-but-untracked public artifacts after build",
    );
    check(
      content.includes(
        "github.event.pull_request.head.repo.full_name == github.repository",
      ) &&
        content.includes(
          "github.event.pull_request.head.repo.full_name != github.repository",
        ) &&
        workflowStepBlock(content, "Upload coverage to Codecov").includes(
          "token: ${{ secrets.CODECOV_TOKEN }}",
        ) &&
        !workflowStepBlock(
          content,
          "Upload coverage to Codecov (fork PR tokenless)",
        ).includes("secrets.CODECOV_TOKEN") &&
        workflowStepBlock(
          content,
          "Upload coverage to Codecov (fork PR tokenless)",
        ).includes("fail_ci_if_error: true") &&
        forkCodecovStepUsesForkBranchPrefix(
          content,
          "Upload coverage to Codecov (fork PR tokenless)",
        ) &&
        forkCodecovStepUsesForkBranchPrefix(
          content,
          "Upload Vitest results to Codecov (fork PR tokenless)",
        ),
      workflow,
      "validate workflow must split Codecov coverage uploads into trusted-token and fork-tokenless paths",
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
    check(
      !/^\s+cache:\s*npm\s*$/m.test(content),
      workflow,
      "publish workflow must not restore shared npm caches on the Cloudflare release path",
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
        refreshJob.includes("npm run build"),
      workflow,
      "publish workflow refresh job must prepare R2 artifacts with the production probe-health build path",
    );
    check(
      !refreshJob.includes("npm run r2:manifest"),
      workflow,
      "publish workflow refresh job must not regenerate the R2 manifest outside the production build timestamp context",
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
    const finalPublishGuard = stepBlock(
      content,
      "Re-restore reviewed artifacts and run final publish guards",
    );
    check(
      finalPublishGuard.includes("npm run assert:probe-health") &&
        finalPublishGuard.includes("npm run scan:public-safety") &&
        finalPublishGuard.includes("npm run validate:private-boundary"),
      workflow,
      "publish workflow must run final probe-health and safety guards after restoring reviewed artifacts",
    );
    const finalGuardIndex = content.indexOf(
      "- name: Re-restore reviewed artifacts and run final publish guards",
    );
    const cloudflareSecretsIndex = content.indexOf(
      "- name: Check Cloudflare publishing secrets",
    );
    check(
      finalGuardIndex !== -1 &&
        cloudflareSecretsIndex !== -1 &&
        finalGuardIndex < cloudflareSecretsIndex,
      workflow,
      "publish workflow must run final publish guards before Cloudflare upload decisions",
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

function workflowStepBlock(content, stepName) {
  const marker = `- name: ${stepName}`;
  const start = content.indexOf(marker);
  if (start === -1) return "";
  const next = content.indexOf("\n      - name:", start + marker.length);
  return content.slice(start, next === -1 ? undefined : next);
}

function forkCodecovStepUsesForkBranchPrefix(content, stepName) {
  const block = workflowStepBlock(content, stepName);
  return /override_branch:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.owner\.login\s*\}\}:\$\{\{\s*github\.event\.pull_request\.head\.ref\s*\}\}/.test(
    block,
  );
}

function stepBlock(content, stepName) {
  const match = content.match(
    new RegExp(
      String.raw`^      - name: ${escapeRegExp(stepName)}\n[\s\S]*?(?=^      - name: |(?![\s\S]))`,
      "m",
    ),
  );
  return match?.[0] || "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
