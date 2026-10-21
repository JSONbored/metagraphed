import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../scripts/lib.ts";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
  run?: string;
}
const workflowPath = ".github/workflows/publish-cloudflare.yml";
const source = readFileSync(path.join(repoRoot, workflowPath), "utf8");
const workflow = parse(source);
const steps = workflow.jobs.refresh.steps as Step[];
const guard = steps.find((step) => step.id === "publication-request");
const publishSteps = workflow.jobs.publish.steps as Step[];
const decision = publishSteps.find((step) => step.id === "cloudflare-secrets")!;

// Execute the live shell guard and live publication decision. No checkout,
// build, credential lookup, publisher or network command runs in this fixture.
function selection(ref: string, mode: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "publication-ref-"));
  const output = path.join(directory, "outputs.txt");
  try {
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", `${guard?.run ?? ""}\n${decision.run}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF: ref,
          GITHUB_OUTPUT: output,
          PUBLISH_MODE: mode,
          CLOUDFLARE_API_TOKEN: "fixture-token",
          CLOUDFLARE_ACCOUNT_ID: "fixture-account",
          METAGRAPH_KV_NAMESPACE_ID: "fixture-namespace",
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      output: existsSync(output) ? readFileSync(output, "utf8") : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("production publication refuses branch and tag dispatches before any write decision", () => {
  for (const ref of [
    "refs/heads/fix/reviewed-change",
    "refs/tags/v1.0.0",
    "",
  ]) {
    const result = selection(ref, "publish");
    assert.equal(result.status, 1, ref);
    assert.match(
      result.stdout,
      /Production registry publication requires refs\/heads\/main/,
    );
    assert.equal(result.output, null);
  }
});

test("main publication and explicit dry runs retain their existing decisions", () => {
  const publish = selection("refs/heads/main", "publish");
  assert.equal(publish.status, 0);
  assert.equal(
    publish.output,
    "publish=true\nkv_publish=true\ndry_run=false\n",
  );
  for (const ref of ["refs/heads/main", "refs/heads/fix/reviewed-change"]) {
    const dry = selection(ref, "dry-run");
    assert.equal(dry.status, 0, ref);
    assert.equal(dry.output, "publish=true\nkv_publish=true\ndry_run=true\n");
  }
  for (const mode of ["", "unexpected"]) {
    const refused = selection("refs/heads/main", mode);
    assert.equal(refused.status, 1, mode);
    assert.equal(refused.output, null);
  }
});

test("the unconditional request guard precedes checkout and shares the write-mode input", () => {
  assert.equal(steps[0], guard);
  assert.equal(guard?.if, undefined);
  assert.equal(guard?.shell, "bash");
  assert.equal(
    guard?.env?.PUBLISH_MODE,
    "${{ github.event_name == 'workflow_dispatch' && inputs.publish_mode || 'publish' }}",
  );
  assert.equal(guard?.env?.PUBLISH_MODE, decision.env?.PUBLISH_MODE);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.publish_mode.default,
    "publish",
  );
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.publish_mode.options, [
    "publish",
    "dry-run",
  ]);
  assert.equal(workflow.jobs.publish.needs, "refresh");
  const failures = steps.filter((step) => step.if?.includes("failure()"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.name, "Notify on failure");
  assert.equal(
    failures[0]?.if,
    "failure() && steps.publication-request.outcome == 'success'",
  );
  for (const step of publishSteps.filter((step) =>
    /npm run (?:r2:upload|kv:publish)|node scripts\/r2-(?:registry|history)-gc\.ts --write/.test(
      step.run ?? "",
    ),
  )) {
    assert.match(
      step.if ?? "",
      /steps\.cloudflare-secrets\.outputs\.dry_run != 'true'/,
    );
  }
});

test("the workflow validator rejects missing or moved guards and notification after refusal", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "publication-workflow-"));
  try {
    for (const name of [
      ".github/workflows",
      "scripts",
      "package.json",
      "codecov.yml",
    ])
      cpSync(path.join(repoRoot, name), path.join(directory, name), {
        recursive: true,
      });
    const validate = () =>
      spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts/validate-workflows.ts")],
        {
          encoding: "utf8",
          env: { ...process.env, METAGRAPH_REPO_ROOT: directory },
        },
      );
    const valid = validate();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const guardBlock = source.match(
      / {6}- name: Validate registry publication request\n[\s\S]*?(?= {6}- name: Checkout\n)/,
    )![0];
    const withoutGuard = source.replace(guardBlock, "");
    assert.notEqual(withoutGuard, source);
    writeFileSync(path.join(directory, workflowPath), withoutGuard);
    const missing = validate();
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /publish workflow must refuse production publication outside main before checkout/,
    );
    const publishStart = withoutGuard.indexOf("\n  publish:");
    assert.ok(publishStart >= 0);
    writeFileSync(
      path.join(directory, workflowPath),
      withoutGuard.slice(0, publishStart) +
        withoutGuard
          .slice(publishStart)
          .replace("    steps:\n", "    steps:\n" + guardBlock),
    );
    const relocated = validate();
    assert.equal(relocated.status, 1);
    assert.match(
      relocated.stderr,
      /publish workflow must refuse production publication outside main before checkout/,
    );
    writeFileSync(
      path.join(directory, workflowPath),
      source.replace(
        "if: failure() && steps.publication-request.outcome == 'success'",
        "if: failure()",
      ),
    );
    const notified = validate();
    assert.equal(notified.status, 1);
    assert.match(
      notified.stderr,
      /publish refresh must notify only failures after an accepted publication request/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const notifications = [steps, publishSteps].map((jobSteps) => {
  const notification = jobSteps.find(
    (step) => step.name === "Notify on failure",
  );
  assert.ok(notification?.run);
  return notification;
});

const fixtureWebhook = "https://fixture.invalid/notification";

// Execute both live notification blocks with a shell function replacing curl.
// The isolated environment has no credentials or executable search path, and
// the function never performs a request. Body/error sentinels catch log leaks.
function notificationResult(
  step: Step,
  httpStatus: string,
  curlExit = 0,
  webhook = fixtureWebhook,
) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "publication-notification-"),
  );
  const argumentsPath = path.join(directory, "arguments");
  const env: Record<string, string | undefined> = {
    PATH: directory,
    ALERT_WEBHOOK_URL: webhook,
    FIXTURE_ARGS: argumentsPath,
    FIXTURE_HTTP_STATUS: httpStatus,
    FIXTURE_CURL_EXIT: String(curlExit),
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "fixture/repository",
    GITHUB_RUN_ID: "123",
  };
  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        "-c",
        `curl() {
          printf '%s\\n' "$@" > "$FIXTURE_ARGS"
          local output='' format=''
          while [ "$#" -gt 0 ]; do
            case "$1" in
              -o|--output) output="$2"; shift ;;
              -w|--write-out) format="$2"; shift ;;
            esac
            shift
          done
          if [ -n "$output" ]; then
            printf '%s' 'fixture-provider-response-body' > "$output"
          else
            printf '%s' 'fixture-provider-response-body'
          fi
          printf '%s' 'fixture-provider-error-with-secret-url' >&2
          if [ "$format" = '%{http_code}' ]; then
            printf '%s' "$FIXTURE_HTTP_STATUS"
          fi
          return "$FIXTURE_CURL_EXIT"
        }
        ${step.run}`,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 5_000,
        env: env as NodeJS.ProcessEnv,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      (result.stdout + result.stderr).includes(fixtureWebhook),
      false,
    );
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      args: existsSync(argumentsPath)
        ? readFileSync(argumentsPath, "utf8").trimEnd().split("\n")
        : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("publish failure notifications remain opt-in and preserve the primary failure", () => {
  assert.equal(notifications.length, 2);
  for (const step of notifications) {
    assert.match(step.if ?? "", /^failure\(\)/);
    assert.equal("continue-on-error" in step, false);
    assert.equal(
      step.env?.ALERT_WEBHOOK_URL,
      "${{ secrets.METAGRAPH_ALERT_WEBHOOK_URL }}",
    );
    const result = notificationResult(step, "204", 0, "");
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.args, []);
    assert.match(result.output, /skipping alert/);
  }
  const smoke = publishSteps.find((step) => step.name === "Smoke live API");
  assert.ok(smoke);
  assert.equal("continue-on-error" in smoke, false);
  assert.match(smoke.run ?? "", /exit 1\s*$/);
  assert.ok(
    publishSteps.indexOf(smoke) < publishSteps.indexOf(notifications[1]!),
  );
});

test("publish failure notifications accept successful HTTP responses without logging provider data", () => {
  for (const step of notifications) {
    for (const status of ["200", "204"]) {
      const result = notificationResult(step, status);
      assert.equal(result.status, 0, result.output);
      assert.doesNotMatch(result.output, /fixture-|::error::/);
      assert.equal(result.args[result.args.indexOf("-m") + 1], "15");
      assert.equal(result.args[result.args.indexOf("-o") + 1], "/dev/null");
      assert.equal(result.args[result.args.indexOf("-w") + 1], "%{http_code}");
      assert.equal(result.args[result.args.indexOf("-X") + 1], "POST");
      const payload = JSON.parse(result.args[result.args.indexOf("-d") + 1]!);
      assert.match(payload.content, /production publish FAILED/);
      assert.match(
        payload.content,
        /https:\/\/github.com\/fixture\/repository\/actions\/runs\/123/,
      );
    }
  }
});

test("publish failure notifications fail visibly for rejected HTTP responses", () => {
  for (const step of notifications) {
    for (const status of ["302", "400", "404", "429", "500"]) {
      const result = notificationResult(step, status);
      assert.equal(result.status, 1, `${status}: ${result.output}`);
      assert.match(result.output, /::error::.*notification/);
      assert.match(result.output, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(result.output, /fixture-/);
    }
  }
});

test("publish failure notifications fail visibly for transport errors without leaking diagnostics", () => {
  for (const step of notifications) {
    for (const exit of [6, 28]) {
      const result = notificationResult(step, "000", exit);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /::error::.*notification.*transport/);
      assert.doesNotMatch(result.output, /fixture-/);
    }
  }
});
