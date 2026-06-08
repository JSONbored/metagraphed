import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, stableStringify } from "./lib.mjs";

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
  const [coverage, profileCompleteness, gapPriorities, adapterCandidates] =
    await Promise.all([
      readArtifact("coverage.json"),
      readArtifact("review/profile-completeness.json"),
      readArtifact("review/gap-priorities.json"),
      readArtifact("review/adapter-candidates.json"),
    ]);

  const profiles = profileCompleteness.profiles || [];
  const priorities = gapPriorities.priorities || [];
  const adapters = adapterCandidates.candidates || [];

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
    },
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
    "",
    "## Best Direct PR Targets",
    "",
    "Submit one public-safe candidate at a time with `npm run candidate:new`. Official docs, websites, source repos, OpenAPI/schema URLs, public subnet APIs, dashboards, SDKs, examples, and data artifacts are the best auto-review candidates.",
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
        `SN${row.netuid} ${row.name} - score ${row.adapter_score}; kinds: ${row.surface_kinds.join(", ")}`,
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
    suggested_adapter: candidate.suggested_adapter,
  };
}

function numberedRows(rows, formatter) {
  if (rows.length === 0) {
    return ["No rows available."];
  }
  return rows.map((row, index) => `${index + 1}. ${formatter(row)}`);
}

async function readArtifact(relativePath) {
  return JSON.parse(
    await readFile(path.join(repoRoot, "public/metagraph", relativePath), {
      encoding: "utf8",
    }),
  );
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
