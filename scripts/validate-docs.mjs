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

for (const requiredReadmeText of [
  "/api/v1/openapi.json",
  "/api/v1/endpoints",
  "/api/v1/subnets/{netuid}/endpoints",
  "/api/v1/providers/{slug}/endpoints",
  "/api/v1/health/history/{date}",
  "/api/v1/subnets/{netuid}/surfaces",
  "/metagraph/endpoints.json",
  "/metagraph/endpoint-pools.json",
  "/metagraph/health/history/{date}.json",
  "/metagraph/types.d.ts",
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
