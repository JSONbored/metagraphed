// #1000 — Cold-start committed-seed gate.
//
// On an R2 cold start — and on any clean checkout — the Worker serves the
// COMMITTED public/ seed (the DUAL-tier artifacts in src/artifact-storage.mjs).
// That seed is only refreshed by a manual `npm run build` + commit, so a
// schema/contract change that lands WITHOUT the seed refresh ships a seed that
// no longer satisfies the contract. #356 did exactly this (added the required
// `readiness_tier` field) and it stayed invisible in CI: the `checks` job builds
// fresh BEFORE `validate:api` runs, so validate:api only ever sees rebuilt
// output, never the committed seed. The drift only surfaced on a contributor's
// clean checkout (and took three iterations to land the #998 catch-up).
//
// This gate runs BEFORE the build and validates the responses the Worker
// produces from the committed seed alone — so seed drift fails fast here.
//
// Scope: only routes backed by a DUAL-tier (committed) artifact are checked.
// R2-only routes (providers, surfaces, search, per-subnet detail, D1-computed
// health/analytics) need a build to populate dist/ and would 404 on a clean
// checkout — they're out of scope here and are covered by validate:api after
// the build. The set is DERIVED from the contract + storage tiers, so new
// committed routes are picked up automatically.

import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { API_ROUTES } from "../src/contracts.mjs";
import { handleRequest } from "../workers/api.mjs";
import {
  ARTIFACT_STORAGE_TIERS,
  artifactStorageTierForPath,
} from "../src/artifact-storage.ts";
import { createLocalArtifactEnv, readJson, repoRoot } from "./lib.mjs";

export const SEED_FAILURE_HINT =
  "Fix: run `npm run build`, then commit the regenerated public/ artifacts " +
  "(the committed seed must track schema/contract changes — see the " +
  "schema-change-regenerate-contract rule).";

// Paramless GET routes whose backing artifact is committed to git (DUAL tier) —
// the only routes guaranteed to resolve from the committed seed on a clean
// checkout, with no build and no R2/D1.
export function committedSeedRoutes(routes = API_ROUTES) {
  return routes.filter(
    (route) =>
      route.method === "GET" &&
      !route.path.includes("{") &&
      route.artifact_path &&
      artifactStorageTierForPath(route.artifact_path) ===
        ARTIFACT_STORAGE_TIERS.dual,
  );
}

// Exercise each committed-seed-backed route through the Worker and validate the
// response against the generated OpenAPI 200 schema. Returns the routes checked
// and a list of human-readable failures (empty = the committed seed is valid).
export async function runCommittedSeedGate({ env, openapi }) {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);

  const routes = committedSeedRoutes();
  const errors = [];

  for (const route of routes) {
    let response;
    try {
      response = await handleRequest(
        new Request(`https://metagraph.sh${route.path}`),
        env,
        {},
      );
    } catch (error) {
      errors.push(`${route.path}: handler threw — ${error?.message ?? error}`);
      continue;
    }
    if (response.status !== 200) {
      errors.push(
        `${route.path}: committed seed should serve 200 (got ${response.status})`,
      );
      continue;
    }
    const body = await response.json();
    if (body.ok !== true) {
      errors.push(`${route.path}: committed seed should serve an ok envelope`);
      continue;
    }
    const operation = openapi.paths?.[route.path]?.[route.method.toLowerCase()];
    const responseSchema =
      operation?.responses?.["200"]?.content?.["application/json"]?.schema;
    if (!responseSchema) {
      errors.push(
        `${route.path}: missing OpenAPI 200 schema in the committed contract`,
      );
      continue;
    }
    const validator = ajv.compile({
      components: openapi.components,
      ...responseSchema,
    });
    if (!validator(body)) {
      errors.push(
        `${route.path}: committed seed response no longer matches the schema — ${ajv.errorsText(
          validator.errors,
        )}`,
      );
    }
  }

  return { checked: routes.length, errors };
}

async function main() {
  const openapi = await readJson(
    path.join(repoRoot, "public/metagraph/openapi.json"),
  );
  const env = createLocalArtifactEnv();
  const { checked, errors } = await runCommittedSeedGate({ env, openapi });

  if (errors.length > 0) {
    console.error(
      `✖ Committed cold-start seed is stale or schema-invalid (${errors.length} issue(s)):`,
    );
    for (const message of errors) {
      console.error(`  - ${message}`);
    }
    console.error(`\n${SEED_FAILURE_HINT}`);
    process.exit(1);
  }

  console.log(
    `✓ Committed cold-start seed valid — ${checked} DUAL-tier route(s) checked (pre-build, no R2/D1).`,
  );
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
