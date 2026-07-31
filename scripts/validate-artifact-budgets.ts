import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateArtifactBudgets } from "./artifact-budgets.ts";
import { repoRoot, sha256Hex } from "./lib.ts";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.ts";

interface ArtifactRecord {
  path: string;
  sha256: string;
  size_bytes: number;
}

const artifactRoot = path.join(repoRoot, "public/metagraph");
const r2ArtifactRoot = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
const artifacts: ArtifactRecord[] = [];

await walk(artifactRoot, async (filePath) => {
  if (!filePath.endsWith(".json")) {
    return;
  }
  const relativePath = path
    .relative(artifactRoot, filePath)
    .replace(/\\/g, "/");
  if (artifactStorageTierForRelativePath(relativePath) === "r2") {
    return;
  }
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
await walk(r2ArtifactRoot, async (filePath) => {
  if (!filePath.endsWith(".json")) {
    return;
  }
  const relativePath = path
    .relative(r2ArtifactRoot, filePath)
    .replace(/\\/g, "/");
  if (relativePath === "r2-manifest.json") {
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

// Sorted by how far over the line each one is, and reported with the headroom
// left before it FAILS. A warning's whole job is to be acted on before it
// becomes an outage, and "1,951,556 >= 750,000" does not say which of these is
// one publish away from breaking (#8778).
const WARNINGS_SHOWN = 25;

if (warnings.length > 0) {
  const ranked = [...warnings].sort(
    (a, b) => b.size_bytes / b.warn_bytes - a.size_bytes / a.warn_bytes,
  );
  console.warn(`Artifact size budget warnings (${warnings.length}):`);
  for (const warning of ranked.slice(0, WARNINGS_SHOWN)) {
    const overWarn = (warning.size_bytes / warning.warn_bytes).toFixed(2);
    const ofFail = ((warning.size_bytes / warning.fail_bytes) * 100).toFixed(0);
    console.warn(
      `- ${warning.path}: ${warning.size_bytes} bytes — ${overWarn}x warn (${warning.warn_bytes}), ${ofFail}% of fail (${warning.fail_bytes})`,
    );
  }
  // The truncation used to be silent: the summary counted all of them while
  // the list stopped at 25, so reading the output left you believing you had
  // seen every warning.
  if (ranked.length > WARNINGS_SHOWN) {
    console.warn(
      `- … and ${ranked.length - WARNINGS_SHOWN} more (showing the ${WARNINGS_SHOWN} furthest over their warn line)`,
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

async function walk(
  dirPath: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
