import { promises as fs } from "node:fs";
import path from "node:path";
import {
  evaluateArtifactBudgets,
  summarizeArtifactBudgets,
} from "./artifact-budgets.mjs";
import {
  buildTimestamp,
  repoRoot,
  sha256Hex,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const outputRoot = path.join(repoRoot, "public/metagraph");
const summaryPath = path.join(outputRoot, "build-summary.json");
const existing = JSON.parse(await fs.readFile(summaryPath, "utf8"));
const artifacts = await collectArtifactSizes(outputRoot);
const artifactBudgets = evaluateArtifactBudgets(artifacts);

await writeJson(summaryPath, {
  ...existing,
  generated_at: existing.generated_at || buildTimestamp(),
  artifact_count: artifacts.length,
  artifact_size_bytes: artifacts.reduce(
    (sum, artifact) => sum + artifact.size_bytes,
    0,
  ),
  artifacts: artifacts.slice(0, 250),
  artifact_budget_summary: summarizeArtifactBudgets(artifactBudgets),
  artifact_budgets: artifactBudgets
    .filter((budget) => budget.status !== "ok")
    .sort(
      (a, b) => b.size_bytes - a.size_bytes || a.path.localeCompare(b.path),
    ),
});

console.log(
  stableStringify({
    artifact_count: artifacts.length,
    artifact_budget_summary: summarizeArtifactBudgets(artifactBudgets),
  }),
);

async function collectArtifactSizes(root) {
  const files = [];
  await walk(root, async (filePath) => {
    if (!filePath.endsWith(".json")) {
      return;
    }
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    if (["build-summary.json", "r2-manifest.json"].includes(relativePath)) {
      return;
    }
    const raw = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    files.push({
      path: relativePath,
      sha256: sha256Hex(raw),
      size_bytes: stat.size,
    });
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

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
