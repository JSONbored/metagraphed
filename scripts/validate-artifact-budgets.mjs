import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateArtifactBudgets } from "./artifact-budgets.mjs";
import { repoRoot, sha256Hex } from "./lib.mjs";

const artifactRoot = path.join(repoRoot, "public/metagraph");
const artifacts = [];

await walk(artifactRoot, async (filePath) => {
  if (!filePath.endsWith(".json")) {
    return;
  }
  const relativePath = path
    .relative(artifactRoot, filePath)
    .replace(/\\/g, "/");
  if (["build-summary.json", "r2-manifest.json"].includes(relativePath)) {
    return;
  }
  const raw = await fs.readFile(filePath);
  artifacts.push({
    path: relativePath,
    sha256: sha256Hex(raw),
    size_bytes: raw.byteLength,
  });
});

const results = evaluateArtifactBudgets(
  artifacts.sort((a, b) => a.path.localeCompare(b.path)),
);
const failures = results.filter((result) => result.status === "fail");
const warnings = results.filter((result) => result.status === "warn");

if (warnings.length > 0) {
  console.warn("Artifact size budget warnings:");
  for (const warning of warnings.slice(0, 25)) {
    console.warn(
      `- ${warning.path}: ${warning.size_bytes} bytes >= ${warning.warn_bytes}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Artifact size budget failures:");
  for (const failure of failures) {
    console.error(
      `- ${failure.path}: ${failure.size_bytes} bytes >= ${failure.fail_bytes}`,
    );
  }
  process.exit(1);
}

console.log(
  `Artifact size budgets passed for ${results.length} artifact(s) with ${warnings.length} warning(s).`,
);

async function walk(dirPath, onFile) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, onFile);
    } else if (entry.isFile()) {
      await onFile(entryPath);
    }
  }
}
