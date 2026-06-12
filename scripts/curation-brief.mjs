import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { artifactFilePath, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const limit = positiveInt(valueAfter("--limit"), 12);

if (isCliEntrypoint()) {
  const snapshot = await loadCurationSnapshot({ limit });

  if (jsonMode) {
    console.log(stableStringify(snapshot));
  } else {
    console.log(renderCurationBrief(snapshot));
  }
}

export async function loadCurationSnapshot({ limit = 12 } = {}) {
  const [
    coverage,
    profileCompleteness,
    gapPriorities,
    adapterCandidates,
    enrichmentQueue,
    enrichmentTargets,
  ] = await Promise.all([
    readArtifact("coverage.json"),
    readArtifact("review/profile-completeness.json"),
    readArtifact("review/gap-priorities.json"),
    readArtifact("review/adapter-candidates.json"),
    readArtifact("review/enrichment-queue.json"),
    readArtifact("review/enrichment-targets.json"),
  ]);

  const profiles = profileCompleteness.profiles || [];
  const priorities = gapPriorities.priorities || [];
  const adapters = adapterCandidates.candidates || [];
  const queue = enrichmentQueue.queue || [];
  const targets = enrichmentTargets.targets || [];

  return {
    schema_version: 1,
    generated_at: profileCompleteness.generated_at,
    contract_version: profileCompleteness.contract_version,
    coverage: {
      active_netuids: coverage.chain_subnet_count,
      application_subnets: coverage.application_subnet_count,
      curated_overlays: coverage.curated_overlay_count,
      native_only: coverage.native_only_count,
      surfaces: coverage.surface_count,
      probed_surfaces: coverage.probed_surface_count,
      candidates: coverage.candidate_count,
    },
    profile_summary: {
      average_completeness_score:
        profileCompleteness.summary?.average_completeness_score ?? null,
      by_level: profileCompleteness.summary?.by_profile_level || {},
      critical_gap_counts:
        profileCompleteness.summary?.critical_gap_counts || {},
      identity_promotion_candidate_count:
        profileCompleteness.summary?.identity_promotion_candidate_count ?? null,
      native_identity_unpromoted_count:
        profileCompleteness.summary?.native_identity_unpromoted_count ?? null,
    },
    enrichment_summary: enrichmentQueue.summary || {},
    enrichment_target_summary: enrichmentTargets.summary || {},
    enrichment_queue: queue.slice(0, limit).map(enrichmentBriefRow),
    enrichment_targets: targets.slice(0, limit).map(enrichmentTargetBriefRow),
    lowest_completeness: profiles.slice(0, limit).map(profileBriefRow),
    highest_gap_priority: priorities.slice(0, limit).map(priorityBriefRow),
    adapter_candidates: adapters.slice(0, limit).map(adapterBriefRow),
    suggested_submission_kinds: [
      "docs",
      "website",
      "source-repo",
      "dashboard",
      "openapi",
      "subnet-api",
      "sse",
      "data-artifact",
      "sdk",
      "example",
    ],
    manual_review_kinds: [
      "provider profile",
      "subtensor-rpc",
      "subtensor-wss",
      "archive endpoint",
      "authenticated API",
      "adapter request",
      "identity dispute",
      "endpoint status report",
    ],
  };
}

export function renderCurationBrief(snapshot) {
  const enrichmentSummary = snapshot.enrichment_summary || {};
  const enrichmentQueue = snapshot.enrichment_queue || [];
  const lines = [
    "# Metagraphed Curation Brief",
    "",
    "Use this brief to choose high-value GitHub issue or PR submissions. It is generated from existing registry review artifacts; it is not a separate contribution API.",
    "",
    "## Coverage",
    "",
    `- Active Finney netuids: ${snapshot.coverage.active_netuids}`,
    `- Application subnets: ${snapshot.coverage.application_subnets}`,
    `- Curated overlays: ${snapshot.coverage.curated_overlays}`,
    `- Native-only entries: ${snapshot.coverage.native_only}`,
    `- Published surfaces/endpoints: ${snapshot.coverage.surfaces}`,
    `- Probed surfaces: ${snapshot.coverage.probed_surfaces}`,
    `- Candidate surfaces: ${snapshot.coverage.candidates}`,
    `- Average profile completeness: ${snapshot.profile_summary.average_completeness_score ?? "unknown"}`,
    `- Profile levels: ${formatCounts(snapshot.profile_summary.by_level)}`,
    `- Identity promotion candidates: ${snapshot.profile_summary.identity_promotion_candidate_count ?? "unknown"}`,
    `- Native identity with unpromoted live links: ${snapshot.profile_summary.native_identity_unpromoted_count ?? "unknown"}`,
    `- Critical gaps: ${formatCounts(snapshot.profile_summary.critical_gap_counts)}`,
    "",
    "## Best Direct PR Targets",
    "",
    "Submit one public-safe candidate at a time with `npm run candidate:new`. Official docs, websites, source repos, OpenAPI/schema URLs, public subnet APIs, dashboards, SDKs, examples, and data artifacts are the best auto-review candidates.",
    "",
    `- Enrichment queue lanes: ${formatCounts(enrichmentSummary.lane_counts)}`,
    `- Evidence actions: ${formatCounts(enrichmentSummary.evidence_action_counts)}`,
    `- Direct-submission targets: ${enrichmentSummary.direct_submission_count ?? "unknown"}`,
    `- Maintainer-review targets: ${enrichmentSummary.maintainer_review_count ?? "unknown"}`,
    `- Manual-review-required targets: ${enrichmentSummary.manual_review_required_count ?? "unknown"}`,
    `- Target-pack kinds: ${formatCounts(snapshot.enrichment_target_summary?.by_kind)}`,
    "",
    ...numberedRows(
      enrichmentQueue,
      (row) =>
        `SN${row.netuid} ${row.name} - ${row.lane}; ${row.evidence_action || "unknown-action"}; priority ${row.priority_score}; ${row.recommended_action}; target kinds: ${row.direct_submission_kinds.join(", ") || "n/a"}; candidates: ${formatCandidateSamples(row)}`,
    ),
    "",
    "## Contributor Target Pack",
    "",
    "These rows are copyable contribution targets. Surface candidates can usually be submitted directly with the command template; adapter, provider, base-layer, and status-review work still routes to manual review.",
    "",
    ...numberedRows(
      snapshot.enrichment_targets || [],
      (row) =>
        `SN${row.netuid} ${row.name} - ${row.target_type}${row.kind ? `/${row.kind}` : ""}; ${row.target_action}; priority ${row.priority_score}; auto-review ${row.auto_review_candidate ? "yes" : "no"}; ${row.candidate_command || row.contribution_prompt}`,
    ),
    "",
    "## Lowest Profile Completeness",
    "",
    ...numberedRows(
      snapshot.lowest_completeness,
      (row) =>
        `SN${row.netuid} ${row.name} - score ${row.completeness_score}; ${row.suggested_next_action}; gaps: ${row.gaps.join(", ")}`,
    ),
    "",
    "## Highest Maintainer Review Priorities",
    "",
    "These entries already have candidate or surface evidence but need stronger maintainer review, official-source confirmation, or adapter consideration.",
    "",
    ...numberedRows(
      snapshot.highest_gap_priority,
      (row) =>
        `SN${row.netuid} ${row.name} - priority ${row.priority_score}; ${row.suggested_next_action}; missing: ${row.missing_kinds.join(", ")}`,
    ),
    "",
    "## Adapter Candidate Queue",
    "",
    "Adapters are for subnets with enough API/schema/data surface to justify subnet-specific normalized metrics.",
    "",
    ...numberedRows(
      snapshot.adapter_candidates,
      (row) =>
        `SN${row.netuid} ${row.name} - score ${row.adapter_score}; ${row.suggested_adapter || "adapter"}; kinds: ${row.surface_kinds.join(", ")}; ${row.suggested_next_action || "review adapter fit"}`,
    ),
    "",
    "## Manual Review Targets",
    "",
    ...snapshot.manual_review_kinds.map((kind) => `- ${kind}`),
    "",
    "Health, uptime, latency, incidents, and pool eligibility stay probe-derived only. Contributor reports can trigger review or re-probes, but they cannot set observed health.",
  ];

  return `${lines.join("\n")}\n`;
}

function enrichmentTargetBriefRow(target) {
  return {
    auto_review_candidate: target.auto_review_candidate,
    candidate_command: target.candidate_command,
    contribution_prompt: target.contribution_prompt,
    kind: target.kind,
    name: target.name,
    netuid: target.netuid,
    priority_score: target.priority_score,
    target_action: target.target_action,
    target_type: target.target_type,
  };
}

function profileBriefRow(profile) {
  return {
    netuid: profile.netuid,
    name: profile.name,
    slug: profile.slug,
    profile_level: profile.profile_level,
    completeness_score: profile.completeness_score,
    priority_score: profile.priority_score,
    candidate_count: profile.candidate_count,
    gaps: profile.gap_reasons || [],
    suggested_next_action: profile.suggested_next_action,
  };
}

function priorityBriefRow(priority) {
  return {
    netuid: priority.netuid,
    name: priority.name,
    slug: priority.slug,
    curation_level: priority.curation_level,
    review_state: priority.review_state,
    priority_score: priority.priority_score,
    surface_count: priority.surface_count,
    candidate_count: priority.candidate_count,
    verified_candidate_count: priority.verified_candidate_count,
    missing_kinds: priority.missing_kinds || [],
    suggested_next_action: priority.suggested_next_action,
  };
}

function adapterBriefRow(candidate) {
  return {
    netuid: candidate.netuid,
    name: candidate.name,
    slug: candidate.slug,
    adapter_score: candidate.adapter_score ?? candidate.priority_score,
    surface_count:
      candidate.surface_count ?? candidate.operational_surface_count ?? 0,
    surface_kinds: candidate.surface_kinds || candidate.operational_kinds || [],
    suggested_adapter:
      candidate.suggested_adapter || candidate.recommended_adapter_kind,
    suggested_next_action: candidate.suggested_next_action,
  };
}

function enrichmentBriefRow(entry) {
  return {
    netuid: entry.netuid,
    name: entry.name,
    slug: entry.slug,
    lane: entry.lane,
    priority_score: entry.priority_score,
    completeness_score: entry.completeness_score,
    direct_submission_kinds: entry.direct_submission_kinds || [],
    evidence_action: entry.evidence_action || null,
    manual_review_required: entry.manual_review_required,
    reason_codes: entry.reason_codes || [],
    recommended_action: entry.recommended_action,
    sample_live_candidate_ids: entry.sample_live_candidate_ids || [],
    sample_stale_candidate_ids: entry.sample_stale_candidate_ids || [],
    sample_target_candidate_ids: entry.sample_target_candidate_ids || [],
  };
}

function numberedRows(rows, formatter) {
  if (rows.length === 0) {
    return ["No rows available."];
  }
  return rows.map((row, index) => `${index + 1}. ${formatter(row)}`);
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function formatCandidateSamples(row) {
  const live = row.sample_live_candidate_ids || [];
  const target = row.sample_target_candidate_ids || [];
  const stale = row.sample_stale_candidate_ids || [];
  if (live.length > 0) {
    return `live ${live.join(", ")}`;
  }
  if (target.length > 0) {
    return target.join(", ");
  }
  if (stale.length > 0) {
    return `stale ${stale.join(", ")}`;
  }
  return "n/a";
}

async function readArtifact(relativePath) {
  // Resolve by storage tier: git-tier artifacts (coverage.json,
  // review/profile-completeness.json) live in public/metagraph; the R2-only
  // enrichment-queue artifacts (gap-priorities, adapter-candidates,
  // enrichment-queue, enrichment-targets) are written to the dist staging tree
  // during a build. artifactFilePath() prefers the staged copy and falls back
  // to public, so a post-build run finds everything.
  const filePath = artifactFilePath(relativePath);
  try {
    return JSON.parse(await readFile(filePath, { encoding: "utf8" }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Curation brief artifact not found: ${relativePath}. Run \`npm run build\` ` +
          `first — the enrichment-queue artifacts are generated into the R2 staging ` +
          `tree (dist/metagraph-r2/metagraph). Or query the live queue at ` +
          `https://api.metagraph.sh/api/v1/review/enrichment-targets.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function valueAfter(flag) {
  const values = process.argv.slice(2);
  const index = values.indexOf(flag);
  return index === -1 ? null : values[index + 1];
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isCliEntrypoint() {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}
