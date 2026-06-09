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
  }
  if (workflow === "submission-gate.yml") {
    check(
      content.includes("metagraphed-submission-gate:"),
      workflow,
      "submission gate workflow must expose the metagraphed-submission-gate job",
    );
    check(
      content.includes("npm run submission:pr"),
      workflow,
      "submission gate workflow must use the checked-in PR classifier",
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
    check(
      !content.includes('METAGRAPH_WRITE_PROBE_RESULTS: "1"'),
      workflow,
      "publish workflow must not write live probe results during deployment",
    );
    check(
      content.includes("npm run artifacts:prepare-local") &&
        content.includes("npm run r2:manifest"),
      workflow,
      "publish workflow must prepare R2 artifacts from reviewed repository inputs",
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
