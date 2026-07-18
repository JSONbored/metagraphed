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
]);

// Cross-file counterpart to GRANDFATHERED_DUPLICATE_URLS, for the check below
// (#6328): a normalized URL explicitly allowed to be claimed by 2+ distinct
// netuids' surfaces, because one operator genuinely runs multiple subnets
// from shared infrastructure (a single corporate site, a monorepo) — the
// surface describes the operator, not any one subnet. Confirmed from the
// resource's own content/structure, not a live probe.
const SHARED_OPERATOR_URLS = new Set([
  // qBittensor Labs' single corporate site legitimately fronts both SN48
  // (Quantum Compute) and SN63 (Enigma) — its own nav/body copy names both
  // ("SN48: Quantum" / "SN63: Enigma") (#6328).
  "https://www.qbittensorlabs.com/",
]);

// Reviewed-tier authorship convention + its acknowledged exemptions (#5739).
// Files at the `maintainer-reviewed` / `adapter-backed` curation tier normally
// pair a non-null `curation.verified_at` with their `reviewed_at` and carry a
// proving `source_urls` on every surface. Exactly three entries deviate — and
// they are a recognized class of specially-seeded, self-referential / pilot
// manifests, recognizable by structural fields (never a filename allowlist):
//   - the netuid-0 root/base-layer overlay, whose surfaces ARE the canonical
//     Bittensor properties (a source_url "proving" bittensor.com is official
//     would be circular) and whose RPC/WSS/archive kinds are maintainer-curated
//     infrastructure rather than contributor surfaces; and
//   - `partnership.tier: "pilot"` manifests (metagraphed's own dogfood subnet
//     plus pilot partners), hand-seeded ahead of the automated review pipeline.
// Those are exempt. ANY OTHER reviewed-tier entry that drops `verified_at` or a
// surface's `source_urls` is surfaced as a non-blocking advisory below, so a
// real future data gap is flagged rather than sitting silently ambiguous.
const REVIEWED_AUTHORSHIP_TIERS = new Set([
  "maintainer-reviewed",
  "adapter-backed",
]);

function conventionExemption(document) {
  if (document.netuid === 0) return "netuid-0 base-layer overlay";
  if (document.partnership?.tier === "pilot") return "pilot manifest";
  return null;
}

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
const conventionAdvisories = [];
const conventionExemptions = [];
const authAdvisories = [];
let surfaceCount = 0;
// #6328: normalized URL -> claimant locations, across ALL files in this run
// (unlike surfaceIdsByUrl below, which resets per-file). Populated in the
// per-surface loop, checked once after every file has been processed.
const surfaceLocationsByUrl = new Map();
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
        const locations = surfaceLocationsByUrl.get(normalized) || [];
        locations.push({
          file: path.basename(file),
          id: surface.id,
          netuid: document.netuid,
        });
        surfaceLocationsByUrl.set(normalized, locations);
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
    // #6331: schema_status: "machine-readable" is a claim that a schema is
    // fetchable somewhere — schema_url is where. Hard error, not advisory:
    // unlike auth's structured object below (sometimes genuinely undocumented
    // by the provider), a machine-readable schema is either served at a URL
    // or the status is simply wrong.
    if (surface.schema_status === "machine-readable" && !surface.schema_url) {
      errors.push(
        `${label}: schema_status "machine-readable" requires a non-empty ` +
          "schema_url — set it (usually the surface's own url) or downgrade " +
          'schema_status to "ui-only"/"not-captured" if no machine-readable spec is actually served.',
      );
    }
    // #6330: auth_required makes a promise ("this needs a credential") the
    // structured auth{} field is what makes caller-actionable ("...and here's
    // how"). Advisory, not a hard error: the credential mechanism is
    // sometimes genuinely undocumented by the provider (auth.scheme:
    // "custom" is the honest answer there, not a blocker), unlike the
    // reviewed-tier convention above this mirrors in shape.
    if (surface.auth_required === true && !surface.auth) {
      authAdvisories.push(
        `${label}: auth_required is true with no structured auth{} object — ` +
          "curate one (scheme at minimum; location/name/value_format where knowable " +
          'from the surface\'s own docs, or scheme: "custom" with a scopes_note if the ' +
          "exact mechanism isn't publicly documented).",
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

  // Reviewed-tier verified_at/source_urls convention (#5739). Advisory, never a
  // hard error: exempt entries (root / pilot manifests) are acknowledged, and
  // any other reviewed-tier entry that deviates is flagged rather than silent.
  if (REVIEWED_AUTHORSHIP_TIERS.has(document.curation?.level)) {
    const missingSourceUrls = (document.surfaces || []).filter(
      (surface) =>
        !Array.isArray(surface.source_urls) || surface.source_urls.length === 0,
    ).length;
    const verifiedAtNull = document.curation?.verified_at == null;
    if (verifiedAtNull || missingSourceUrls > 0) {
      const label = path.basename(file);
      const exemption = conventionExemption(document);
      if (exemption) {
        conventionExemptions.push(`${label} (${exemption})`);
      } else {
        const gaps = [];
        if (verifiedAtNull) gaps.push("curation.verified_at is null");
        if (missingSourceUrls > 0) {
          gaps.push(`${missingSourceUrls} surface(s) lack source_urls`);
        }
        conventionAdvisories.push(
          `${label}: ${document.curation.level} entry deviates from the ` +
            `reviewed-tier convention (${gaps.join("; ")}). Backfill to match ` +
            "the reviewed-tier shape, or mark it exempt if it is a " +
            "self-referential/pilot manifest.",
        );
      }
    }
  }
}

// #6328: cross-file counterpart to the within-file duplicate-URL check above
// (#5737) — that one only ever sees one document at a time, so an identical
// URL copy-pasted into TWO subnet files under different netuids slips past
// it. Only meaningful on a multi-file run: a single-file
// `validate:surface -- registry/subnets/x.json` invocation can't see what
// another netuid claims, so it's skipped rather than false-negative-guessed
// — `npm run validate` (no file args) always covers it.
if (files.length > 1) {
  for (const [normalizedUrl, locations] of surfaceLocationsByUrl) {
    if (SHARED_OPERATOR_URLS.has(normalizedUrl)) continue;
    const netuids = new Set(locations.map((location) => location.netuid));
    if (netuids.size > 1) {
      const claimants = locations
        .map(
          (location) =>
            `${location.file} (${location.id}, netuid=${location.netuid})`,
        )
        .join("; ");
      errors.push(
        `Cross-file duplicate: "${normalizedUrl}" is registered by ${locations.length} surface(s) across ${netuids.size} distinct netuids — ${claimants}. ` +
          "Fix one to a true per-subnet endpoint, remove/reclassify it from the subnet that doesn't own it, or add it to " +
          "SHARED_OPERATOR_URLS if one operator genuinely runs multiple subnets from shared infrastructure.",
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

// #5739 — make the reviewed-tier convention non-silent: name the acknowledged
// exemptions, and loudly flag any non-exempt deviation as a real data gap.
if (conventionExemptions.length > 0) {
  console.log(
    `Reviewed-tier convention: ${conventionExemptions.length} acknowledged exemption(s) ` +
      `(self-referential / pilot manifests) — ${conventionExemptions.join(", ")}.`,
  );
}
if (conventionAdvisories.length > 0) {
  console.warn(
    `\nReviewed-tier convention advisory (${conventionAdvisories.length} — not blocking):`,
  );
  for (const advisory of conventionAdvisories) console.warn(`- ${advisory}`);
}
// #6330 — auth_required with no auth{} object, non-blocking.
if (authAdvisories.length > 0) {
  console.warn(
    `\nauth_required advisory (${authAdvisories.length} — not blocking):`,
  );
  for (const advisory of authAdvisories) console.warn(`- ${advisory}`);
}

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
