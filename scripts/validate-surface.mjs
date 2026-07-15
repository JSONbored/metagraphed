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

// Pre-existing duplicate-URL registrations, grandfathered so the new
// duplicate-URL check below (added for #5737) only fails a contributor PR
// that introduces a NEW duplicate rather than breaking `validate:surface`
// repo-wide on debt this check wasn't around to prevent. The data-fix for
// the first 3 (#5736) is blocked behind a maintainer-only registry-deletion
// review gate, not something a contributor PR can land; 8-ball.json's is a
// 4th instance this check additionally surfaced. Remove an entry here once
// its underlying duplicate is actually resolved in the registry file.
const GRANDFATHERED_DUPLICATE_URLS = new Set([
  "8-ball.json|https://github.com/Barbariandev/8Ball_miner",
  "allways.json|https://api.all-ways.io/miners/leaderboard",
  "bitmind.json|https://api.bitmind.ai/health",
  "gradients.json|https://api.gradients.io/v1/network/status",
]);

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
    path.join(repoRoot, "registry/candidates/generated/public-sources.json"),
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
    errors.push(
      `${path.basename(file)}: ${formatValidationErrors(validate.errors, document)}`,
    );
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
  // Track normalized-URL -> surface ids so the exact-same-URL-under-two-kinds
  // mistake (e.g. a subnet-api and a data-artifact surface both pointing at
  // the same endpoint) fails here instead of silently landing in the
  // registry — see #5736 for 3 confirmed live instances this would have caught.
  const surfaceIdsByUrl = new Map();
  for (const surface of document.surfaces || []) {
    surfaceCount += 1;
    const label = `${path.basename(file)} (${surface.id})`;
    if (surface.url) {
      const normalized = normalizePublicUrl(surface.url);
      if (normalized) {
        const ids = surfaceIdsByUrl.get(normalized) || [];
        ids.push(surface.id);
        surfaceIdsByUrl.set(normalized, ids);
      }
    }
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
        nativeChainLiveKeys.has(
          `${surface.kind}|${document.netuid}|${normalized}`,
        )
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
  for (const [normalizedUrl, ids] of surfaceIdsByUrl) {
    if (
      ids.length > 1 &&
      !GRANDFATHERED_DUPLICATE_URLS.has(
        `${path.basename(file)}|${normalizedUrl}`,
      )
    ) {
      errors.push(
        `${path.basename(file)}: "${normalizedUrl}" is registered by ${ids.length} surfaces (${ids.join(", ")}) — ` +
          "dedupe to the one surface kind that accurately describes the endpoint.",
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

// ajv.errorsText() collapses every error to its bare `message`, which for an
// `enum` keyword is the unhelpful "must be equal to one of the allowed
// values" with no indication of what those values actually are. Reproduce:
// set a surface's `kind` to an invalid value and run this script — the error
// gives no hint of the valid enum. Fix: for enum-keyword errors, append the
// allowed values (and the offending value, when resolvable from the document)
// to the message; every other keyword's message is left untouched.
function formatValidationErrors(errors, document) {
  return (errors || [])
    .map((error) => {
      let message = error.message;
      if (error.keyword === "enum") {
        const allowed = (error.params?.allowedValues || []).join(", ");
        const actual = valueAtInstancePath(document, error.instancePath);
        const gotSuffix =
          actual === undefined ? "" : ` (got ${JSON.stringify(actual)})`;
        message = `${message}: ${allowed}${gotSuffix}`;
      }
      return `${error.instancePath} ${message}`;
    })
    .join(", ");
}

function valueAtInstancePath(document, instancePath) {
  if (!instancePath) return undefined;
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = document;
  for (const segment of segments) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}
