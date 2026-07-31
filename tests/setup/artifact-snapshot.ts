// globalSetup: take ONE pristine copy of the working tree before any test file
// runs, and hand every per-file sandbox a frozen source to clone from.
//
// The earlier shape of this cloned the live repo per test file, which is racy by
// construction: scripts/lib.ts writes JSON atomically (write `<name>.<pid>.<rand>`,
// then rename), so any concurrent writer leaves temp files that exist when the
// copy lists a directory and are gone when it reads them. That surfaced as an
// intermittent ENOENT on `dist/metagraph-r2/metagraph/testnet/subnets/*.json.*`
// and cannot be fixed by choosing a different copy tool — cp, fs.cpSync and
// rsync all just report the vanish differently. Tolerating it would also be
// wrong: it would silently accept a half-copied sandbox.
//
// globalSetup runs once, in the main process, before any worker starts, so the
// tree is quiescent exactly then. Every sandbox afterwards copies from this
// snapshot, never from the repo — so no sandbox can ever observe a partial
// write, regardless of what the suite does concurrently.
//
// The path is derived deterministically from the repo root rather than passed
// through env or vitest's provide/inject, because workers are separate
// processes and must be able to recompute it with no IPC.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRoot } from "../../scripts/lib.ts";

// Never worth copying: node_modules and .git dominate the cost, .claude holds
// other agents' full repo copies, and coverage/report output is written by the
// run itself.
const EXCLUDES = [
  "node_modules",
  ".git",
  ".claude",
  "coverage",
  "coverage-mocked",
  "coverage-tmp",
  "reports",
];

export function snapshotRoot(): string {
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return path.join(tmpdir(), `metagraphed-snapshot-${key}`);
}

export async function setup(): Promise<void> {
  const snapshot = snapshotRoot();
  rmSync(snapshot, { recursive: true, force: true });

  const result = spawnSync(
    "rsync",
    [
      "-a",
      ...EXCLUDES.map((entry) => `--exclude=/${entry}`),
      `${repoRoot}/`,
      `${snapshot}/`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `artifact-snapshot: rsync failed (status ${result.status}): ${result.stderr ?? ""}`,
    );
  }
  if (!existsSync(snapshot)) {
    throw new Error(`artifact-snapshot: snapshot missing at ${snapshot}`);
  }
}

export async function teardown(): Promise<void> {
  rmSync(snapshotRoot(), { recursive: true, force: true });
}
