import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./lib.mjs";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.mjs";

const trackedPublicArtifacts = execFileSync(
  "git",
  ["ls-files", "public/metagraph"],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
)
  .split(/\r?\n/)
  .filter(Boolean);

const originals = new Map();
for (const relativePath of trackedPublicArtifacts) {
  const filePath = path.join(repoRoot, relativePath);
  originals.set(relativePath, {
    existed: existsSync(filePath),
    content: existsSync(filePath) ? await readFile(filePath) : null,
  });
}
const schemaSnapshotDetails = await loadSchemaSnapshotDetails();

const result = spawnSync(process.execPath, ["scripts/build-artifacts.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
  },
  stdio: "pipe",
});

for (const [relativePath, original] of originals) {
  const filePath = path.join(repoRoot, relativePath);
  if (!original.existed) {
    await rm(filePath, { force: true });
    continue;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, original.content);
}

for (const [relativePath, content] of schemaSnapshotDetails) {
  const filePath = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(
  JSON.stringify(
    {
      mode: "local-r2-staging",
      result: "prepared",
      restored_public_artifact_count: originals.size,
    },
    null,
    2,
  ),
);

async function loadSchemaSnapshotDetails() {
  const indexPath = path.join(repoRoot, "public/metagraph/schemas/index.json");
  if (!existsSync(indexPath)) {
    return new Map();
  }

  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const details = new Map();
  for (const entry of index.schemas || []) {
    const relativePath = String(entry.path || "")
      .replace(/^\/+metagraph\//, "")
      .replace(/^\/+/, "");
    if (!relativePath || relativePath === "schemas/index.json") {
      continue;
    }
    const filePath = path.join(
      repoRoot,
      R2_STAGING_RELATIVE_ROOT,
      relativePath,
    );
    if (existsSync(filePath)) {
      details.set(relativePath, await readFile(filePath));
    }
  }
  return details;
}
