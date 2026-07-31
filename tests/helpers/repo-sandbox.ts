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

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRoot } from "../../scripts/lib.ts";

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

// Never worth copying: node_modules and .git dominate the cost, .claude holds
// other agents' full repo copies, and the coverage/report outputs are written
// by the run itself.
const NEVER_COPY = new Set([
  "node_modules",
  ".git",
  ".claude",
  "coverage",
  "coverage-mocked",
  "coverage-tmp",
  "reports",
]);

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

export function createRepoSandbox(
  label = "artifacts",
  { scope = "data" }: RepoSandboxOptions = {},
): RepoSandbox {
  const root = mkdtempSync(path.join(tmpdir(), `metagraphed-${label}-`));
  const entries =
    scope === "full"
      ? readdirSync(repoRoot).filter((entry) => !NEVER_COPY.has(entry))
      : DATA_DIRS;
  for (const dir of entries) {
    const source = path.join(repoRoot, dir);
    if (!existsSync(source)) continue;
    cpSync(source, path.join(root, dir), { recursive: true });
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
