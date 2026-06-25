// Client-SDK drift gate.
//
// The published `@jsonbored/metagraphed` client is a thin re-export of the
// repo's generated contract (`packages/client/scripts/sync-generated.mjs` copies
// `generated/metagraphed-api.d.ts` + `generated/metagraphed-client.ts` into the
// package on build, and the package tracks `public/metagraph/openapi.json`). But
// release-please versions the `client` component ONLY from changes under
// `packages/client/**` — a contract-only PR (schemas → generated → openapi.json)
// touches none of those, so it opens a `platform`/`python` release PR while the
// client silently stays on its old version and never republishes. The npm
// package then drifts behind the live contract until someone notices.
//
// This gate closes that hole deterministically: on a PR, if any CONTRACT file
// changed versus the merge base BUT `packages/client/package.json` "version" did
// NOT change, fail with a clear remediation message. It is diff-scoped, so a PR
// that touches no contract file never fires — only contract changes are gated.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, repoRoot } from "./lib.mjs";

// The contract surface the published client re-exports. A change to any of these
// versus the merge base means the npm package's shipped types/openapi would
// drift unless the client version is bumped in the same PR. Kept in sync with
// packages/client/scripts/sync-generated.mjs (the generated copies) + the
// package's openapi tracking.
export const CONTRACT_PATHS = [
  "public/metagraph/openapi.json",
  "generated/metagraphed-api.d.ts",
  "generated/metagraphed-client.ts",
];

export const CLIENT_MANIFEST_PATH = "packages/client/package.json";

export const SYNC_FAILURE_HINT =
  "contract changed — bump packages/client + manifest + dispatch Publish client " +
  "SDK, see packages/client/PUBLISHING.md";

// Pure decision function (unit-tested): given the PR's changed-file list and
// whether the client version actually changed, decide whether the gate fails.
// `changedFiles` is a list of repo-relative POSIX paths (deletions included is
// fine — a deleted contract file is still a contract change). `versionChanged`
// is true when packages/client/package.json "version" differs from the base.
export function evaluateClientSdkSync({ changedFiles, versionChanged }) {
  const normalized = changedFiles
    .map((file) => file.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const contractFiles = CONTRACT_PATHS.filter((contract) =>
    normalized.includes(contract),
  );
  const contractChanged = contractFiles.length > 0;
  return {
    contractChanged,
    contractFiles,
    versionChanged,
    // Fail only when a contract file moved but the client version did not.
    ok: !contractChanged || versionChanged,
  };
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Resolve the merge base to diff against. Prefer the explicit base SHA the
// trusted workflow passes (PR contents are untrusted); fall back to the merge
// base with origin/<base-ref> for a local run.
function resolveBaseRef() {
  const explicitBase = valueAfter("--base-sha") || process.env.BASE_SHA;
  if (explicitBase) return explicitBase;
  const baseRef = valueAfter("--base-ref") || process.env.BASE_REF || "main";
  try {
    return git(["merge-base", `origin/${baseRef}`, "HEAD"]);
  } catch {
    return git(["merge-base", baseRef, "HEAD"]);
  }
}

function resolveHeadRef() {
  return valueAfter("--head-sha") || process.env.HEAD_SHA || "HEAD";
}

function changedFilesFromGit(baseRef, headRef) {
  const out = git(["diff", "--name-only", baseRef, headRef]);
  return out ? out.split(/\r?\n/) : [];
}

// Read the "version" field of the client manifest as committed at a git ref.
// Returns null when the file does not exist at that ref (e.g. the package was
// added in this PR).
function clientVersionAt(ref) {
  try {
    const content = git(["show", `${ref}:${CLIENT_MANIFEST_PATH}`]);
    return JSON.parse(content).version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const baseRef = resolveBaseRef();
  const headRef = resolveHeadRef();

  const changedFiles = changedFilesFromGit(baseRef, headRef);

  const baseVersion = clientVersionAt(baseRef);
  const headManifest = await readJson(
    path.join(repoRoot, CLIENT_MANIFEST_PATH),
  );
  const headVersion = headManifest.version ?? null;
  const versionChanged = baseVersion !== headVersion;

  const result = evaluateClientSdkSync({ changedFiles, versionChanged });

  if (!result.ok) {
    console.error(
      `✖ Client-SDK drift: the published contract changed but ` +
        `${CLIENT_MANIFEST_PATH} "version" was not bumped (${baseVersion} → ${headVersion}).`,
    );
    console.error("  Changed contract file(s):");
    for (const file of result.contractFiles) {
      console.error(`    - ${file}`);
    }
    console.error(`\n  ${SYNC_FAILURE_HINT}`);
    process.exit(1);
  }

  if (result.contractChanged) {
    console.log(
      `✓ Contract changed and packages/client "version" bumped ` +
        `(${baseVersion} → ${headVersion}) — client SDK in sync.`,
    );
  } else {
    console.log("✓ No contract files changed — client-SDK drift gate N/A.");
  }
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
