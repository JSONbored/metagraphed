import { spawnSync } from "node:child_process";
import {
  DEPLOY_OWNED_ARTIFACTS,
  dirtyTrackedPaths,
  resolveBaseRemote,
  stableStringify,
} from "./lib.mjs";

interface Step {
  name: string;
  args: string[];
  env: Record<string, string>;
}

interface StepResult {
  name: string;
  status: "passed" | "failed";
  elapsed_ms: number;
}

const productionBuild = isProductionPublishBuild();
const startedAt = new Date().toISOString();
const effectiveBuildTimestamp =
  process.env.METAGRAPH_BUILD_TIMESTAMP || (productionBuild ? startedAt : null);
const steps = productionBuild ? productionSteps() : localSteps();
const results: StepResult[] = [];

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

revertDeployOwnedArtifactsIfChanged();

function revertDeployOwnedArtifactsIfChanged(): void {
  // A real publish run (productionBuild) is expected to update these files —
  // leave them alone in that context. Everywhere else (plain local/CI validate
  // build), r2-manifest.json is inherently non-deterministic build output
  // (its *_artifact_size_bytes totals sum the live R2-only artifacts, which
  // legitimately vary build-to-build) — never a signal about YOUR change. A
  // human manually reverting it before every commit was the actual recurring
  // papercut, so auto-revert here instead of just warning.
  //
  // Revert only the DEPLOY_OWNED_ARTIFACTS members that are ACTUALLY dirty,
  // not the whole set the moment any one member is: schemas/index.json is
  // deploy-owned in the same sense (its committed copy is a network-capture
  // cache, not this build's output) but, unlike r2-manifest.json, nothing in
  // localSteps()/productionSteps() above ever writes it -- the only thing
  // that legitimately changes it is sync-schema-snapshots.yml's dedicated
  // `schemas:snapshot` step, committed directly to its own PR. A blanket
  // revert of the whole array used to stomp that legitimate commit back to
  // origin/main just because r2-manifest.json also showed dirty in the same
  // build, which guaranteed ci-verify-submitted-artifacts.ts would always
  // see committed != rebuilt and fail that PR's `checks` job.
  if (productionBuild) {
    return;
  }
  const dirty: string[] = dirtyTrackedPaths(
    DEPLOY_OWNED_ARTIFACTS,
    process.cwd(),
  );
  if (dirty.length === 0) {
    return;
  }
  const baseRemote = resolveBaseRemote(process.cwd());
  const revert = spawnSync(
    "git",
    ["checkout", `${baseRemote}/main`, "--", ...dirty],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (revert.status !== 0) {
    // Fall back to the old warning if the auto-revert itself fails (e.g. no
    // network access to fetch the base remote's latest main) — don't hide a
    // dirty working tree silently if we couldn't actually clean it up.
    console.warn(
      [
        "",
        "warning: build modified deploy-owned artifact(s), and auto-revert failed:",
        ...dirty.map((file) => `  - ${file}`),
        revert.stderr || "",
        "Revert them manually before committing:",
        "",
        `  git checkout ${baseRemote}/main -- ${dirty.join(" ")}`,
        "",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "",
      "note: build produced non-deterministic deploy-owned artifact(s), auto-reverted to",
      `${baseRemote}/main (see DEPLOY_OWNED_ARTIFACTS in scripts/lib.mjs):`,
      ...dirty.map((file) => `  - ${file}`),
      "",
    ].join("\n"),
  );
}

function localSteps(): Step[] {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.ts", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs", {
      METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
    }),
    // After build-artifacts (which wipes the R2 staging root) and before
    // r2-manifest: build the non-default network registries (testnet) into the
    // R2 staging tree so they're picked up by the manifest + upload.
    nodeStep("build-network-registries", "scripts/build-network-registry.ts"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.ts", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function productionSteps(): Step[] {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.ts", "--write"),
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
    nodeStep("capture-fixtures", "scripts/capture-fixtures.ts", "--write"),
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
    nodeStep("build-network-registries", "scripts/build-network-registry.ts"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.ts", "--write"),
    // Reads registry-summary.json (just rewritten by build-artifacts above)
    // for live stats and renders the /og.png card into the same R2 staging
    // tree, so r2-manifest below picks it up like any other artifact (#6502).
    // Tolerant like native-snapshot/refresh-candidates -- never fails the
    // build; see that script's own header.
    nodeStep("refresh-og-image", "scripts/refresh-og-image.mjs"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function nodeStep(
  name: string,
  script: string,
  ...argsOrEnv: (string | Record<string, string>)[]
): Step {
  const last = argsOrEnv.at(-1);
  const env =
    typeof last === "object" && !Array.isArray(last)
      ? (argsOrEnv.pop() as Record<string, string>)
      : {};
  return {
    name,
    args: [script, ...(argsOrEnv as string[])],
    env,
  };
}

function isProductionPublishBuild(): boolean {
  if (process.env.METAGRAPH_PRODUCTION_BUILD === "1") {
    return true;
  }
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_WORKFLOW === "Publish Cloudflare Backend" &&
    process.env.GITHUB_REF === "refs/heads/main"
  );
}
