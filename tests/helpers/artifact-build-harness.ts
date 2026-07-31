// Shared setup for the test files that run the REAL scripts/build-artifacts.ts.
//
// Extracted from tests/artifacts.test.ts when the build-running tests were
// split across several files (#8937 follow-up). Those tests dominate CI: six of
// them ran a full build, 7.2s to 24.7s each, 99.4s of the file's 118.8s -- and
// that file was 118.8s of a 144.3s pass, so it alone set the floor for the whole
// shared-registry run. vitest parallelizes across FILES and never within one,
// and test.concurrent would not have helped either: these builds go through
// execFileSync, which blocks the worker's event loop, so same-file concurrency
// still serializes them. Sibling files land on separate workers, which is the
// only arrangement that actually overlaps them.
//
// Each file needs its own sandbox -- a sandbox is per-file state, and two builds
// writing one tree is the race #8937 removed -- so this is a factory rather than
// a module-level singleton.
//
// The extra clone per file is ~0.6s against a ~20s build -- the trade is
// overwhelmingly worth it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

import {
  artifactDirectoryPath as realArtifactDirectoryPath,
  artifactFilePath as realArtifactFilePath,
  repoRoot as realRepoRoot,
} from "../../scripts/lib.ts";
import { createRepoSandbox } from "./repo-sandbox.ts";

export interface ArtifactBuildHarness {
  /** The sandbox root — every expected path is built from this. */
  root: string;
  /** Re-roots an absolute real-repo path into the sandbox. */
  toSandbox: (real: string) => string;
  /** lib.ts's artifactFilePath, answered against the sandbox. */
  artifactFilePath: (
    relativePath: string,
    options?: { allowPublicFallback?: boolean },
  ) => string;
  /** lib.ts's artifactDirectoryPath, answered against the sandbox. */
  artifactDirectoryPath: (relativePath: string) => string;
  publicMetagraphRoot: string;
  r2StagingRoot: string;
  /** The sandbox's served public/ tree. */
  publicTree: string;
  /** cwd for spawning the real scripts — the REAL repo (only data is redirected). */
  scriptCwd: string;
  /** Env carrying METAGRAPH_REPO_ROOT, for child processes. */
  env: NodeJS.ProcessEnv;
  /** Runs a real script against the sandbox's data via METAGRAPH_REPO_ROOT. */
  runNode: (script: string) => void;
  /** Parsed JSON of a sandbox artifact. */
  readArtifact: (relativePath: string) => Record<string, unknown>;
  /** Every file under `dir`, recursively. */
  walkFiles: (dir: string) => string[];
  /**
   * Snapshot the committed support artifacts a forged rebuild would overwrite,
   * so the build's own output can be rolled back afterwards.
   */
  snapshotSupportArtifacts: () => Map<string, string>;
  restoreSupportArtifacts: (snapshot: Map<string, string>) => void;
}

function walkFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Builds a per-FILE sandbox plus the path helpers and script runner the
 * build-running tests need, and registers the hooks that keep the sandbox's
 * public/ tree byte-stable across the file and delete the sandbox afterwards.
 *
 * Call once at module scope. `label` only names the temp directory.
 *
 * The path helpers re-root lib.ts's real answers rather than reimplementing
 * them: artifactFilePath's public-vs-R2 tier routing is real logic, and the
 * sandbox is a byte copy taken moments earlier, so lib's existsSync-based
 * routing resolves identically in both trees.
 */
export function createArtifactBuildHarness(
  label: string,
): ArtifactBuildHarness {
  const sandbox = createRepoSandbox(label);
  const toSandbox = (real: string) =>
    path.join(sandbox.root, path.relative(realRepoRoot, real));
  const publicTree = path.join(sandbox.root, "public");

  // Snapshot/restore the served public/ tree so the build-running tests leave it
  // exactly as they found it — build-artifacts.ts regenerates from current
  // source, which drifts from the committed seed, so restoring exact bytes keeps
  // repeated runs within a file idempotent.
  const snapshotPublicTree = (): Map<string, Buffer> => {
    if (!existsSync(publicTree)) return new Map();
    return new Map(
      walkFilesRecursive(publicTree).map((file: string): [string, Buffer] => [
        file,
        readFileSync(file),
      ]),
    );
  };
  const restorePublicTree = (snapshot: Map<string, Buffer>) => {
    if (existsSync(publicTree)) {
      for (const file of walkFilesRecursive(publicTree)) {
        if (!snapshot.has(file)) rmSync(file);
      }
    }
    for (const [file, bytes] of snapshot) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  };

  let publicTreeSnapshot: Map<string, Buffer>;
  beforeAll(() => {
    publicTreeSnapshot = snapshotPublicTree();
  });
  afterAll(() => {
    restorePublicTree(publicTreeSnapshot);
    sandbox.cleanup();
  });

  const artifactFilePath = (
    relativePath: string,
    options?: { allowPublicFallback?: boolean },
  ) => toSandbox(realArtifactFilePath(relativePath, options));

  // Sandbox-rooted, NOT repo-relative. A bare relative path resolves against
  // process.cwd() — the real repo — so this would truncate and rewrite the
  // committed public/metagraph/r2-manifest.json while the rest of the suite
  // reads it, non-atomically (#8937 follow-up).
  const supportArtifactPaths = [
    path.join(sandbox.root, "public/metagraph/r2-manifest.json"),
  ];

  return {
    root: sandbox.root,
    toSandbox,
    artifactFilePath,
    artifactDirectoryPath: (relativePath) =>
      toSandbox(realArtifactDirectoryPath(relativePath)),
    publicMetagraphRoot: sandbox.publicMetagraphRoot,
    r2StagingRoot: sandbox.r2StagingRoot,
    publicTree,
    scriptCwd: sandbox.scriptCwd,
    env: sandbox.env,
    readArtifact: (relativePath: string) =>
      JSON.parse(readFileSync(artifactFilePath(relativePath), "utf8")),
    walkFiles: walkFilesRecursive,
    snapshotSupportArtifacts: () =>
      new Map(
        supportArtifactPaths.map((filePath): [string, string] => [
          filePath,
          readFileSync(filePath, "utf8"),
        ]),
      ),
    restoreSupportArtifacts: (snapshot: Map<string, string>) => {
      for (const [filePath, content] of snapshot) {
        writeFileSync(filePath, content);
      }
      execFileSync(process.execPath, ["scripts/r2-manifest.ts", "--write"], {
        cwd: sandbox.scriptCwd,
        encoding: "utf8",
        env: sandbox.env,
        stdio: "pipe",
      });
      for (const [filePath, content] of snapshot) {
        writeFileSync(filePath, content);
      }
    },
    runNode: (script: string) => {
      execFileSync(process.execPath, [script], {
        cwd: sandbox.scriptCwd,
        encoding: "utf8",
        stdio: "pipe",
        // The committed artifacts are an inert cold-start seed (ADR 0006) that
        // drifts from live source between publishes. This suite validates
        // structure; committed-vs-fresh freshness parity is gated in CI
        // (post-build) instead.
        env: { ...sandbox.env, METAGRAPH_ALLOW_SEED_DRIFT: "1" },
      });
    },
  };
}
