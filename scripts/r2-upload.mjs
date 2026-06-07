import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readJson, repoRoot, sha256Hex, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const manifest = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);

if (!write) {
  console.log(
    stableStringify({
      mode: "dry-run",
      artifact_count: manifest.artifact_count,
      bucket_name: manifest.bucket_name,
      latest_prefix: manifest.latest_prefix,
      run_prefix: manifest.run_prefix,
    }),
  );
  process.exit(0);
}

if (process.env.METAGRAPH_ALLOW_R2_UPLOAD !== "1") {
  console.error(
    "Refusing to upload to R2 without METAGRAPH_ALLOW_R2_UPLOAD=1.",
  );
  process.exit(1);
}

for (const artifact of manifest.artifacts) {
  const localPath = path.join(
    repoRoot,
    "public/metagraph",
    artifact.path.replace(/^\/metagraph\//, ""),
  );
  verifyLocalArtifact(localPath, artifact);
  putObject(localPath, artifact.key, manifest.bucket_name);
  putObject(localPath, artifact.latest_key, manifest.bucket_name);
}

console.log(
  `Uploaded ${manifest.artifact_count} artifact(s) to R2 bucket ${manifest.bucket_name}.`,
);

function verifyLocalArtifact(localPath, artifact) {
  const actual = sha256Hex(readFileSync(localPath));
  if (actual !== artifact.sha256) {
    throw new Error(
      `local artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`,
    );
  }
}

function putObject(localPath, key, bucketName) {
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(
    wranglerBin,
    ["r2", "object", "put", `${bucketName}/${key}`, "--file", localPath],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler r2 object put failed for ${key}`);
  }
}
