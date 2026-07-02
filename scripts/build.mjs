import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";

// Deploy/publish-pipeline-owned artifacts: their committed copies reflect the
// last real publish, not a local/CI validate build, and normal `npm run
// build` runs are expected to leave them looking "stale" relative to HEAD
// (see the "Verify committed derived artifacts are fresh" step in
// .github/workflows/validate.yml for the full reasoning). A production
// publish run legitimately updates these, so the warning below is skipped
// in that context.
const DEPLOY_OWNED_ARTIFACTS = [
  "public/metagraph/r2-manifest.json",
  "public/metagraph/schemas/index.json",
];

const productionBuild = isProductionPublishBuild();
const startedAt = new Date().toISOString();
const effectiveBuildTimestamp =
  process.env.METAGRAPH_BUILD_TIMESTAMP || (productionBuild ? startedAt : null);
const steps = productionBuild ? productionSteps() : localSteps();
const results = [];

for (const step of steps) {
  const started = performance.now();
  const result = spawnSync(process.execPath, step.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(effectiveBuildTimestamp
        ? { METAGRAPH_BUILD_TIMESTAMP: effectiveBuildTimestamp }
        : {}),
      ...(step.env || {}),
    },
    stdio: "pipe",
  });
  const elapsedMs = Math.round(performance.now() - started);
  results.push({
    name: step.name,
    status: result.status === 0 ? "passed" : "failed",
    elapsed_ms: elapsedMs,
  });

  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");

  if (result.status !== 0) {
    console.error(
      stableStringify({
        mode: productionBuild ? "production-publish" : "local",
        failed_step: step.name,
        results,
      }),
    );
    process.exit(result.status || 1);
  }
}

console.log(
  stableStringify({
    mode: productionBuild ? "production-publish" : "local",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    result_count: results.length,
    results,
  }),
);

warnIfDeployOwnedArtifactsChanged();

function warnIfDeployOwnedArtifactsChanged() {
  // A real publish run (productionBuild) is expected to update these files —
  // don't warn in that context. Everywhere else (plain local/CI validate
  // build), a diff here is the footgun this warning exists to catch.
  if (productionBuild) {
    return;
  }
  const diff = spawnSync(
    "git",
    ["status", "--porcelain", "--", ...DEPLOY_OWNED_ARTIFACTS],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (diff.status !== 0 || !diff.stdout.trim()) {
    return;
  }
  const baseRemote = resolveBaseRemote();
  console.warn(
    [
      "",
      "warning: build modified deploy-owned artifact(s):",
      ...DEPLOY_OWNED_ARTIFACTS.map((file) => `  - ${file}`),
      "These reflect the last real publish, not this local/CI build, and will",
      "always differ for reasons unrelated to your change (see the",
      '"Verify committed derived artifacts are fresh" step in',
      ".github/workflows/validate.yml). Revert them before committing:",
      "",
      `  git checkout ${baseRemote}/main -- ${DEPLOY_OWNED_ARTIFACTS.join(" ")}`,
      "",
    ].join("\n"),
  );
}

// Forks (Phase A0) set up `upstream` pointing at the canonical repo, with
// `origin` as the contributor's own fork — possibly stale relative to it. A
// direct clone of the canonical repo has no `upstream` remote at all, so
// `origin` there IS canonical. Prefer `upstream` when present.
function resolveBaseRemote() {
  const result = spawnSync("git", ["remote"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const remotes = (result.stdout || "").split("\n").map((line) => line.trim());
  return remotes.includes("upstream") ? "upstream" : "origin";
}

function localSteps() {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.mjs", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs", {
      METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
    }),
    // After build-artifacts (which wipes the R2 staging root) and before
    // r2-manifest: build the non-default network registries (testnet) into the
    // R2 staging tree so they're picked up by the manifest + upload.
    nodeStep("build-network-registries", "scripts/build-network-registry.mjs"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.mjs", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function productionSteps() {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.mjs", "--write"),
    // Refresh the finney native chain snapshot fresh each publish (ADR 0006
    // step 2) so the registry stays current without the retired scheduled
    // sync-subnets PR. Tolerant: a chain RPC failure keeps the last snapshot and
    // the publish proceeds — it never blocks on the chain being reachable.
    nodeStep("native-snapshot", "scripts/refresh-native-snapshot.mjs"),
    // Refresh candidate discovery + verification fresh each publish (issue #599)
    // so their >24h block-freshness gate doesn't hard-fail the scheduled publish
    // now that the sync PR is retired (#571). Runs AFTER native-snapshot
    // (discover-candidates reads it); tolerant like native-snapshot — a live
    // network failure keeps the last committed data and the publish proceeds.
    nodeStep("refresh-candidates", "scripts/refresh-candidates.mjs"),
    // Capture live OpenAPI/Swagger specs (full document + auth) before
    // build-artifacts, so the per-surface schema files carry the real spec for
    // get_api_schema. build-artifacts grabs the document before its staging wipe
    // and re-attaches it; the index stays light. Degrades to digests if a spec
    // is unreachable (snapshot-openapi handles unavailable surfaces).
    nodeStep("schemas-snapshot", "scripts/snapshot-openapi.mjs", "--write"),
    // Re-snapshot adapters from live GitHub metadata so the publish is
    // self-sufficient for freshness: adapter-snapshots are then fresh by
    // construction at publish time (the publish already re-probes health),
    // so the freshness gate never depends on a recently-merged sync PR.
    // Auth posture (METAGRAPH_REQUIRE_ADAPTER_AUTH) + token are supplied by
    // the caller (publish-cloudflare.yml); without a token this carries
    // forward committed adapter data rather than failing.
    nodeStep("adapters-snapshot", "scripts/snapshot-adapters.mjs", "--write"),
    // Capture one sanitized live request/response sample per no-auth GET
    // surface (issue #352) before build-artifacts, mirroring schemas-snapshot:
    // build-artifacts grabs the fixtures/{surface_id}.json files before its
    // staging wipe, re-attaches them, and builds the fixtures.json index that
    // powers the get_fixture MCP tool. Degrades gracefully — every unreachable
    // surface is skipped (the step always exits 0), so a flaky surface never
    // blocks the publish. Without this step the index is empty and get_fixture
    // returns nothing.
    nodeStep("capture-fixtures", "scripts/capture-fixtures.mjs", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs"),
    nodeStep("probes-smoke", "scripts/probes-smoke.mjs", {
      METAGRAPH_WRITE_PROBE_RESULTS: "1",
    }),
    nodeStep(
      "build-artifacts-with-probe-health",
      "scripts/build-artifacts.mjs",
      {
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
    ),
    // After the final build-artifacts (R2 staging wipe) and before r2-manifest.
    nodeStep("build-network-registries", "scripts/build-network-registry.mjs"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.mjs", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function nodeStep(name, script, ...argsOrEnv) {
  const env =
    typeof argsOrEnv.at(-1) === "object" && !Array.isArray(argsOrEnv.at(-1))
      ? argsOrEnv.pop()
      : {};
  return {
    name,
    args: [script, ...argsOrEnv],
    env,
  };
}

function isProductionPublishBuild() {
  if (process.env.METAGRAPH_PRODUCTION_BUILD === "1") {
    return true;
  }
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_WORKFLOW === "Publish Cloudflare Backend" &&
    process.env.GITHUB_REF === "refs/heads/main"
  );
}
