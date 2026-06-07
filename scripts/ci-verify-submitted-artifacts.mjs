import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const changedFilesPath = valueAfter("--changed-files") || "changed-files.txt";

const PROBE_DERIVED_PUBLIC_ARTIFACTS = new Set([
  "public/metagraph/build-summary.json",
  "public/metagraph/changelog.json",
  "public/metagraph/endpoint-incidents.json",
  "public/metagraph/endpoint-pools.json",
  "public/metagraph/endpoints.json",
  "public/metagraph/freshness.json",
  "public/metagraph/health/summary.json",
  "public/metagraph/r2-manifest.json",
  "public/metagraph/rpc-endpoints.json",
  "public/metagraph/rpc/pools.json",
]);

const submittedArtifacts = readFileSync(changedFilesPath, "utf8")
  .split(/\r?\n/)
  .map((file) => file.trim().replace(/\\/g, "/"))
  .filter((file) => file.startsWith("public/metagraph/"));

if (submittedArtifacts.length === 0) {
  console.log("No submitted public artifacts to verify.");
  process.exit(0);
}

const deterministicArtifacts = submittedArtifacts.filter(
  (file) => !PROBE_DERIVED_PUBLIC_ARTIFACTS.has(file),
);
const probeDerivedArtifacts = submittedArtifacts.filter((file) =>
  PROBE_DERIVED_PUBLIC_ARTIFACTS.has(file),
);

if (probeDerivedArtifacts.length > 0) {
  console.log("Probe-derived public artifacts are validated by schema gates:");
  for (const file of probeDerivedArtifacts) {
    console.log(`- ${file}`);
  }
}

if (deterministicArtifacts.length === 0) {
  console.log("No deterministic submitted public artifacts to diff-check.");
  process.exit(0);
}

try {
  execFileSync("git", ["diff", "--exit-code", "--", ...deterministicArtifacts], {
    encoding: "utf8",
    stdio: "pipe",
  });
  console.log("Deterministic submitted public artifacts are reproducible.");
} catch (error) {
  process.stdout.write(error.stdout || "");
  process.stderr.write(error.stderr || "");
  console.error(
    [
      "Submitted deterministic public artifacts are not reproducible.",
      "Run `npm run build` and commit the regenerated deterministic artifacts.",
      "Probe-derived health/endpoint summaries are intentionally excluded from this diff check.",
    ].join("\n"),
  );
  process.exit(error.status || 1);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}
