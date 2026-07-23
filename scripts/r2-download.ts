import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import {
  flagValue,
  readJson,
  repoRoot,
  sha256Hex,
  stableStringify,
} from "./lib.ts";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForPath,
} from "../src/artifact-storage.ts";

type Row = Record<string, unknown>;

interface PlannedArtifact {
  key: string;
  local_path: string;
  sha256: string;
  size_bytes: number;
}

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const manifest: Row = await readJson(
  path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, "r2-manifest.json"),
);
// Both `--prefix=latest/` and `--prefix latest/` are accepted: the equals-only
// parser this used to have silently dropped the space-separated form and fell
// back to manifest.latest_prefix, which is how endpoint-ops-brief.ts's
// remediation command came to be wrong for over a release (#6365).
const prefixArg = flagValue(process.argv, "--prefix");
const prefix = prefixArg
  ? prefixArg.replace(/^\/+|\/+$/g, "") + "/"
  : (manifest.latest_prefix as string);
// flagValue's untyped .mjs default param (fallback = undefined) locks TS's
// cross-file inference to exactly undefined; cast until Phase 4 Batch 7
// converts scripts/lib.ts.
const outputDir: string = (
  flagValue as (argv: string[], flag: string, fallback?: string) => string
)(process.argv, "--out", "tmp/r2-download");
const planned: PlannedArtifact[] = (manifest.artifacts as Row[]).map(
  (artifact) => ({
    key: `${prefix}${(artifact.path as string).replace(/^\/metagraph\//, "")}`,
    local_path: localArtifactPath(outputDir, artifact.path as string),
    sha256: artifact.sha256 as string,
    size_bytes: artifact.size_bytes as number,
  }),
);

if (!write) {
  console.log(
    stableStringify({
      mode: "dry-run",
      artifact_count: planned.length,
      bucket_name: manifest.bucket_name,
      output_dir: outputDir,
      prefix,
      sample: planned.slice(0, 10),
    }),
  );
  process.exit(0);
}

if (process.env.METAGRAPH_ALLOW_R2_DOWNLOAD !== "1") {
  console.error(
    "Refusing to download from R2 without METAGRAPH_ALLOW_R2_DOWNLOAD=1.",
  );
  process.exit(1);
}

for (const artifact of planned) {
  await mkdir(path.dirname(artifact.local_path), { recursive: true });
  getObject(artifact.key, artifact.local_path, manifest.bucket_name as string);
  await verifyDownloadedArtifact(artifact);
}

console.log(
  `Downloaded ${planned.length} artifact(s) from R2 bucket ${manifest.bucket_name}.`,
);

async function verifyDownloadedArtifact(
  artifact: PlannedArtifact,
): Promise<void> {
  const actual = sha256Hex(await readFile(artifact.local_path));
  if (actual !== artifact.sha256) {
    throw new Error(
      `downloaded artifact hash mismatch for ${artifact.key}: expected ${artifact.sha256}, got ${actual}`,
    );
  }
}

function getObject(key: string, localPath: string, bucketName: string): void {
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(
    wranglerBin,
    ["r2", "object", "get", `${bucketName}/${key}`, "--file", localPath],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler r2 object get failed for ${key}`);
  }
}

function localArtifactPath(baseDir: string, artifactPath: string): string {
  const relativePath = artifactPath.replace(/^\/metagraph\//, "");
  const tier = artifactStorageTierForPath(artifactPath);
  if (tier === "r2") {
    return path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, relativePath);
  }
  return path.join(baseDir, relativePath);
}
