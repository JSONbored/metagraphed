// Fast, local fail-fast validator for a contributor's subnet file, to run BEFORE
// pushing. Validates registry/subnets/<slug>.json against
// schemas/subnet-manifest.schema.json, checks each surface's `provider` slug is
// registered, and requires a `review.state` on any community-authority surface
// (the single-file contribution model). Quick subset of `npm run validate`.
//
//   npm run validate:surface -- registry/subnets/<slug>.json
//   npm run validate:surface          # validates every subnet file
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import path from "node:path";
import {
  classifyNativeName,
  listJsonFiles,
  loadProviders,
  normalizePublicUrl,
  readJson,
  repoRoot,
} from "./lib.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const validate = ajv.compile(schema);
const providerIds = new Set(
  (await loadProviders()).map((provider) => provider.id),
);
// Base-layer chain endpoints are maintainer-curated network infrastructure that
// live ONLY on the root subnet (netuid 0) and feed the /rpc endpoint lane — they
// are NOT per-subnet contributor surfaces. Enforce the boundary here (the
// contributor template already omits these kinds; this closes the hand-crafted
// PR gap) without touching the probe-derived endpoint pipeline. See issue #1680.
const BASE_LAYER_KINDS = new Set(["subtensor-rpc", "subtensor-wss", "archive"]);

// Build the set of (netuid, normalized-url) keys for native-chain candidates that
// are already machine-promoted (classification live or redirected). A community
// surface duplicating one of these adds no signal — the build pipeline injects it
// automatically via generateBaselineOverlaySet / augmentManualOverlaysWithBaseline.
// Loaded here at start-up so the per-surface loop stays O(1). Silently skipped
// when the generated artifacts are absent (fresh clone, offline run).
const LIVE_CLASSIFICATIONS = new Set(["live", "redirected"]);
const nativeChainLiveKeys = new Set();
try {
  const publicSources = await readJson(
    path.join(
      repoRoot,
      "registry/candidates/generated/public-sources.json",
    ),
  );
  const promotions = await readJson(
    path.join(repoRoot, "registry/verification/promotions.json"),
  );
  const classificationById = new Map(
    (promotions.results || []).map((r) => [r.candidate_id, r.classification]),
  );
  for (const candidate of publicSources.candidates || []) {
    if (
      candidate.source_tier === "native-chain" &&
      LIVE_CLASSIFICATIONS.has(classificationById.get(candidate.id))
    ) {
      const normalized = normalizePublicUrl(candidate.url);
      if (normalized) {
        nativeChainLiveKeys.add(
          `${candidate.kind}|${candidate.netuid}|${normalized}`,
        );
      }
    }
  }
} catch {
  // Candidate data unavailable — skip the native-chain dedup check.
}

const fileArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const files =
  fileArgs.length > 0
    ? fileArgs.map((arg) => path.resolve(arg))
    : await listJsonFiles(path.join(repoRoot, "registry/subnets"));

const errors = [];
let surfaceCount = 0;
for (const file of files) {
  let document;
  try {
    document = await readJson(file);
  } catch (error) {
    errors.push(`${path.basename(file)}: not readable JSON — ${error.message}`);
    continue;
  }
  if (!validate(document)) {
    errors.push(`${path.basename(file)}: ${ajv.errorsText(validate.errors)}`);
    continue;
  }
  // Reject placeholder display names (e.g. "Team TBC", "Subnet 86") unless the
  // maintainer has deliberately tagged the subnet "identity-placeholder" — the
  // documented escape hatch for subnets that genuinely have no on-chain identity.
  if (
    classifyNativeName(document.name, document.netuid).quality !== "chain" &&
    !(document.categories || []).includes("identity-placeholder")
  ) {
    errors.push(
      `${path.basename(file)}: subnet name ${JSON.stringify(document.name)} is a placeholder — ` +
        'set a real curated display name, or tag the subnet "identity-placeholder" if it genuinely has no on-chain identity.',
    );
  }
  for (const surface of document.surfaces || []) {
    surfaceCount += 1;
    const label = `${path.basename(file)} (${surface.id})`;
    if (surface.provider && !providerIds.has(surface.provider)) {
      errors.push(
        `${label}: provider "${surface.provider}" is not a registered slug — ` +
          "run `npm run providers:list`, or pass `--provider-name` to surface:add to debut it.",
      );
    }
    if (surface.authority === "community" && !surface.review?.state) {
      errors.push(
        `${label}: a community surface must carry review.state ` +
          '(e.g. "community-submitted"). Use `npm run surface:add`.',
      );
    }
    if (
      surface.authority === "community" &&
      surface.url &&
      nativeChainLiveKeys.size > 0
    ) {
      const normalized = normalizePublicUrl(surface.url);
      if (
        normalized &&
        nativeChainLiveKeys.has(`${surface.kind}|${document.netuid}|${normalized}`)
      ) {
        errors.push(
          `${label}: "${surface.url}" is already machine-promoted from on-chain ` +
            "SubnetIdentitiesV3 — this surface adds no new signal (the build pipeline " +
            "injects it automatically). Submit a surface the machine cannot discover: " +
            "openapi, subnet-api, sse, data-artifact, or sdk.",
        );
      }
    }
    if (BASE_LAYER_KINDS.has(surface.kind) && document.netuid !== 0) {
      errors.push(
        `${label}: base-layer endpoint kind "${surface.kind}" is only allowed on the ` +
          "root subnet (netuid 0) — these are maintainer-curated network infrastructure " +
          "(the /rpc endpoint lane), not per-subnet contributor surfaces.",
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`Surface validation failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    "\nThis is a fast local pre-check; `npm run validate` runs the full registry validation in CI.",
  );
  process.exit(1);
}
console.log(
  `Surface validation passed: ${surfaceCount} surface(s) across ${files.length} subnet file(s).`,
);
