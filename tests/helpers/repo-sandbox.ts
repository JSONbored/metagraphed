// A private copy of the repo's DATA directories, so a test that runs the real
// build/validate scripts writes into its own tree instead of the shared one.
//
// The three filesystem-mutating tests (artifacts, public-safety,
// refresh-build-summary) used to be quarantined into a serial pass
// (`test:ci:artifacts`, ~115s of CI) purely because they rebuilt or mutated the
// single on-disk artifact tree that every createLocalArtifactEnv reader also
// serves from. Give each its own root and they parallelize like everything else
// (#8937).
//
// Only DATA is copied. The scripts keep loading from their real location and
// resolve every path through scripts/lib.ts's `repoRoot`, which honours
// METAGRAPH_REPO_ROOT — so one env var on the child process redirects all 48
// `public/**` write sites, both artifact roots, and every
// R2_STAGING_RELATIVE_ROOT consumer at once.
//
// IMPORTANT: callers must build their own paths from the returned `root`, and
// must NOT rely on setting METAGRAPH_REPO_ROOT before importing scripts/lib.ts.
// Since #8936 the suite runs with `isolate: false`, so lib.ts may already have
// been evaluated by an earlier test file in the same worker, with its
// repoRoot-derived consts already frozen against the real repo. Explicit paths
// are order-independent; the import-time trick is not.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRoot } from "../../scripts/lib.ts";
import { snapshotRoot } from "../setup/artifact-snapshot.ts";

// Everything the build/validate scripts read or write. Deliberately not the
// whole repo: node_modules and .git dominate the copy cost and no script under
// test touches them through repoRoot.
const DATA_DIRS = [
  "registry",
  "public",
  "dist",
  "schemas",
  "schemas-src",
  ".cache",
];

export interface RepoSandbox {
  /** Absolute path to the sandbox root — build every expected path from this. */
  root: string;
  /**
   * cwd for spawning the real scripts. This is the REAL repo, not the sandbox:
   * only data is redirected, so `scripts/*.ts` must still resolve where they
   * actually live. Pair it with `env` — never with `root`.
   */
  scriptCwd: string;
  /** Env for child processes: inherits the caller's, with the root redirected. */
  env: NodeJS.ProcessEnv;
  /** Path helper mirroring scripts/lib.ts's artifactFilePath, sandbox-rooted. */
  artifactPath: (relative: string) => string;
  /** The sandbox's R2 staging root (dist/metagraph-r2/metagraph). */
  r2StagingRoot: string;
  /** The sandbox's public/metagraph root. */
  publicMetagraphRoot: string;
  cleanup: () => void;
}

export interface RepoSandboxOptions {
  /**
   * "data" (default) copies only the directories the build/validate scripts
   * read and write — enough for anything that runs build-artifacts or
   * refresh-build-summary.
   *
   * "full" copies the whole working tree minus NEVER_COPY. Needed by tests that
   * exercise a script which WALKS the repo (scan-public-safety.ts walks every
   * target root, including scripts/, deploy/ and apps/), because a data-only
   * sandbox would make those roots vanish mid-scan.
   */
  scope?: "data" | "full";
}

// Copies from the frozen snapshot (tests/setup/artifact-snapshot.ts), never
// from the live repo — so a concurrent atomic write in the real tree can never
// make a sandbox partial. Any non-zero status is a real failure and throws:
// there is no benign vanish case left to tolerate.
function copyTree(source: string, destination: string): void {
  const result = spawnSync("rsync", ["-a", `${source}/`, `${destination}/`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `repo-sandbox: rsync ${source} -> ${destination} failed ` +
        `(status ${result.status}): ${result.stderr ?? ""}`,
    );
  }
}

export function createRepoSandbox(
  label = "artifacts",
  { scope = "data" }: RepoSandboxOptions = {},
): RepoSandbox {
  const root = mkdtempSync(path.join(tmpdir(), `metagraphed-${label}-`));
  const snapshot = snapshotRoot();
  if (!existsSync(snapshot)) {
    throw new Error(
      `repo-sandbox: no snapshot at ${snapshot}. tests/setup/artifact-snapshot.ts ` +
        `must be registered as vitest globalSetup.`,
    );
  }
  if (scope === "full") {
    // One rsync of the snapshot root. Copying per top-level entry is wrong:
    // the root holds regular files too, and `rsync -a file/ dest/` is invalid.
    copyTree(snapshot, root);
  } else {
    for (const dir of DATA_DIRS) {
      const source = path.join(snapshot, dir);
      if (!existsSync(source)) continue;
      copyTree(source, path.join(root, dir));
    }
  }

  // Several scripts resolve tooling from `repoRoot/node_modules` directly
  // (generate-types.ts and validate-contract-drift.ts spawn
  // node_modules/openapi-typescript/bin/cli.js). Symlink rather than copy --
  // node_modules is the one directory that would dominate the clone cost.
  const realNodeModules = path.join(repoRoot, "node_modules");
  if (existsSync(realNodeModules)) {
    symlinkSync(realNodeModules, path.join(root, "node_modules"), "dir");
  }

  const publicMetagraphRoot = path.join(root, "public/metagraph");
  return {
    root,
    scriptCwd: repoRoot,
    env: { ...process.env, METAGRAPH_REPO_ROOT: root },
    artifactPath: (relative: string) =>
      path.join(publicMetagraphRoot, relative),
    r2StagingRoot: path.join(root, "dist/metagraph-r2/metagraph"),
    publicMetagraphRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
