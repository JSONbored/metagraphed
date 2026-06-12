import { promises as fs } from "node:fs";
import path from "node:path";
import { API_ROUTES, PUBLIC_ARTIFACTS } from "../src/contracts.mjs";
import { repoRoot } from "./lib.mjs";

const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
const backendContracts = await fs.readFile(
  path.join(repoRoot, "docs/backend-artifact-contracts.md"),
  "utf8",
);
const errors = [];

for (const artifact of PUBLIC_ARTIFACTS) {
  check(
    backendContracts.includes(artifact.path),
    `docs/backend-artifact-contracts.md missing artifact ${artifact.path}`,
  );
}

for (const route of API_ROUTES) {
  check(
    backendContracts.includes(route.path),
    `docs/backend-artifact-contracts.md missing route ${route.path}`,
  );
}

// The README is intentionally minimal + quickstart-first; the exhaustive route
// and artifact coverage is enforced in docs/backend-artifact-contracts.md (the
// checks above). Here we only guard that the key live-resource pointers a
// reader needs stay present in the README.
for (const requiredReadmeText of [
  "metagraph.sh",
  "api.metagraph.sh/mcp",
  "@jsonbored/metagraphed",
  "pip install metagraphed",
  "/metagraph/openapi.json",
  "docs/api-stability.md",
]) {
  check(
    README_HAS(requiredReadmeText),
    `README.md missing ${requiredReadmeText}`,
  );
}

if (errors.length > 0) {
  console.error(
    `Documentation validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Documentation contract validation passed.");

function README_HAS(value) {
  return readme.includes(value);
}

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}
