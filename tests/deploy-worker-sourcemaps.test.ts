// The Worker deploy script's FAILURE POSTURE (#11421).
//
// `scripts/deploy-worker-with-sourcemaps.sh` ships three production Workers,
// and it had no test. On 2026-08-17 every Workers Build in the account failed
// at `posthog-cli sourcemap inject` -- a 30s network timeout to
// `us.i.posthog.com` -- on three Workers and unrelated branches, identically on
// retrigger. The wrangler build had SUCCEEDED in every one; the bytes were
// ready to ship. A third-party observability endpoint being unreachable had
// become an estate-wide deploy outage.
//
// The script's own header already had the rule, written for #10916 when the
// cli could be MISSING: "A Worker deployed without symbolication is a small
// observability loss; a Worker that did not deploy is an outage." It simply
// was not applied to the cli FAILING. These tests pin both halves, plus the one
// failure that must stay fatal.
//
// Driven through a stubbed PATH rather than mocked internals: the thing under
// test is a bash script's control flow under `set -euo pipefail`, and the only
// honest way to exercise that is to run it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "scripts",
  "deploy-worker-with-sourcemaps.sh",
);

/**
 * A sandbox whose `npx` and `git` are shell stubs that log every invocation.
 *
 * `failInject`/`failUpload` make the matching posthog phase exit non-zero,
 * which is exactly what the live outage did.
 */
function sandbox({
  failInject = false,
  failUpload = false,
  emitBundles = 1,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sourcemaps-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");

  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env bash
echo "npx $*" >> ${JSON.stringify(log)}
args="$*"
case "$args" in
  *"--no-install @posthog/cli --version"*) exit 0 ;;
  *"sourcemap inject"*) exit ${failInject ? 1 : 0} ;;
  *"sourcemap upload"*) exit ${failUpload ? 1 : 0} ;;
  *"--dry-run"*)
    # wrangler's build phase: write the bundle(s) the script then globs for.
    outdir=""
    prev=""
    for a in $args; do
      if [ "$prev" = "--outdir" ]; then outdir="$a"; fi
      prev="$a"
    done
    mkdir -p "$outdir"
    for i in $(seq 1 ${emitBundles}); do echo "// bundle" > "$outdir/entry$i.js"; done
    exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(join(bin, "npx"), 0o755);

  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
echo "0000000000000000000000000000000000000000"
`,
    { mode: 0o755 },
  );
  chmodSync(join(bin, "git"), 0o755);

  return { dir, bin, log };
}

function run(
  opts: Parameters<typeof sandbox>[0] & { preview?: boolean } = {},
): { calls: string[]; failed: boolean } {
  const { dir, bin, log } = sandbox(opts);
  const args = ["fake.jsonc", ...(opts.preview ? ["--preview"] : [])];
  let failed = false;
  try {
    execFileSync("bash", [SCRIPT, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        POSTHOG_CLI_API_KEY: "phc_test",
        POSTHOG_CLI_PROJECT_ID: "220683",
      },
      stdio: "pipe",
    });
  } catch {
    failed = true;
  }
  // The log is absent only if the script died before its first stub call --
  // itself a result worth reporting as "no calls" rather than a throw here.
  let calls: string[];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return { calls, failed };
}

/** Did a wrangler call that actually SHIPS (not `--dry-run`) happen? */
const shipped = (calls: string[]) =>
  calls.some((c) => c.includes("wrangler") && !c.includes("--dry-run"));

describe("the deploy survives PostHog being unreachable (#11421)", () => {
  test("a healthy run injects, uploads, and ships the injected bundle", () => {
    const { calls, failed } = run();
    assert.equal(failed, false);
    assert.ok(calls.some((c) => c.includes("sourcemap inject")));
    assert.ok(calls.some((c) => c.includes("sourcemap upload")));
    // The injected file is shipped with --no-bundle, or wrangler's esbuild
    // would rebuild from source and discard the chunk marker.
    assert.ok(
      calls.some((c) => c.includes("--no-bundle")),
      "the exact injected bundle is what ships",
    );
  });

  test("a failing INJECT still deploys, without symbolication", () => {
    const { calls, failed } = run({ failInject: true });
    assert.equal(failed, false, "a posthog outage is not a deploy outage");
    assert.ok(shipped(calls), "the Worker still shipped");
    assert.ok(
      !calls.some((c) => c.includes("sourcemap upload")),
      "and did not try to upload a map for a bundle it never injected",
    );
    assert.ok(
      !calls.some((c) => c.includes("--no-bundle")),
      "the fallback rebuilds from source rather than shipping a half-injected file",
    );
  });

  test("a failing UPLOAD still deploys, and ships no orphan chunk id", () => {
    // The subtler half. `inject` succeeded, so the bundle in $OUTDIR carries a
    // chunk marker -- but its map never landed. Shipping THAT file would leave
    // PostHog resolving traces against a chunk id it has no map for. The
    // fallback rebuilds from source, so the marker never reaches production.
    const { calls, failed } = run({ failUpload: true });
    assert.equal(failed, false);
    assert.ok(shipped(calls), "the Worker still shipped");
    assert.ok(
      !calls.some((c) => c.includes("--no-bundle")),
      "the marked bundle is NOT what ships when its map failed to upload",
    );
  });

  test("an ambiguous bundle glob still FAILS -- that one is ours", () => {
    // The control that stops "tolerate failures" becoming "tolerate anything".
    // Two .js files means wrangler emitted something this script cannot reason
    // about, and shipping the wrong one mis-symbolicates silently. A third
    // party being down is not our bug; this is.
    const { failed } = run({ emitBundles: 2 });
    assert.equal(failed, true);
  });

  test("the preview mode takes the same posture", () => {
    const { calls, failed } = run({ failInject: true, preview: true });
    assert.equal(failed, false);
    assert.ok(calls.some((c) => c.includes("versions upload")));
  });
});
