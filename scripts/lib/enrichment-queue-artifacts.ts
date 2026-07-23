// Enrichment queue / evidence / targets artifact derivation, extracted verbatim
// from scripts/build-artifacts.mjs (#2042 maintainability decomposition). Pure +
// side-effect free: every function takes plain objects and returns plain objects,
// with no module state and no I/O, so the output is byte-identical to the in-
// build-artifacts.mjs originals. Imported directly by scripts/build-artifacts.mjs.
import { normalizePublicUrl, slugify } from "../lib.ts";

// Candidates, profiles, review/verification rows, and derived queue/evidence/
// target entries are untrusted dynamic JSON, read only for artifact derivation
// -- never trusted for control flow. Mirrors the readJson/readArtifactJson
// precedent in scripts/lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function countBy(
  items: Row[],
  keyOrFn: string | ((item: Row) => string),
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator: Record<string, number>, item) => {
        const key =
          typeof keyOrFn === "function" ? keyOrFn(item) : item[keyOrFn];
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function groupBy(
  items: Row[],
  key: string | ((item: Row) => unknown),
): Map<unknown, Row[]> {
  const groups = new Map<unknown, Row[]>();
  for (const item of items) {
    const groupKey = typeof key === "function" ? key(item) : item[key];
    const group = groups.get(groupKey) || [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}

function groupByNetuid(items: Row[]): Map<unknown, Row[]> {
  return groupBy(items, "netuid");
}

interface BuildEnrichmentQueueArtifactsOptions {
  candidates: Row[];
  curationReview: Row;
  profiles: Row[];
  reviewProfiles: Row[];
  subnets: Row[];
  verification: Row;
  contractVersion: string;
  generatedAt: string;
}

interface BuildEnrichmentQueueArtifactsResult {
  evidenceArtifact: Row;
  queueArtifact: Row;
  targetArtifact: Row;
}

export function buildEnrichmentQueueArtifacts({
  candidates,
  curationReview,
  profiles,
  reviewProfiles,
  subnets,
  verification,
  contractVersion,
  generatedAt,
}: BuildEnrichmentQueueArtifactsOptions): BuildEnrichmentQueueArtifactsResult {
  const verificationByCandidate = new Map<unknown, Row>(
    (verification.results || []).map((result: Row) => [
      result.candidate_id,
      result,
    ]),
  );
  const reviewProfileByNetuid = new Map<unknown, Row>(
    reviewProfiles.map((profile) => [profile.netuid, profile]),
  );
  const gapPriorityByNetuid = new Map<unknown, Row>(
    (curationReview.gap_priorities || []).map((priority: Row) => [
      priority.netuid,
      priority,
    ]),
  );
  const adapterCandidateByNetuid = new Map<unknown, Row>(
    (curationReview.adapter_candidates || []).map((candidate: Row) => [
      candidate.netuid,
      candidate,
    ]),
  );
  const excludedCandidateIdsByNetuid = new Map<unknown, Set<unknown>>(
    subnets.map((subnet) => [
      subnet.netuid,
      new Set(subnet.baseline_excluded_surface_ids || []),
    ]),
  );
  const excludedCandidateUrlsByNetuid = new Map<unknown, Set<string>>(
    subnets.map((subnet) => [
      subnet.netuid,
      new Set<string>(
        (subnet.baseline_excluded_surface_urls || [])
          .map((url: string) => normalizePublicUrl(url))
          .filter(Boolean),
      ),
    ]),
  );
  const candidatesByNetuid = groupByNetuid(candidates);

  const fullQueue: Row[] = profiles
    .map((profile) =>
      enrichmentQueueEntry({
        adapterCandidate: adapterCandidateByNetuid.get(profile.netuid),
        gapPriority: gapPriorityByNetuid.get(profile.netuid),
        profile,
        reviewProfile: reviewProfileByNetuid.get(profile.netuid),
        subnetCandidates: enrichmentCandidatesForSubnet({
          excludedIds: excludedCandidateIdsByNetuid.get(profile.netuid),
          excludedUrls: excludedCandidateUrlsByNetuid.get(profile.netuid),
          subnetCandidates: candidatesByNetuid.get(profile.netuid) || [],
        }),
        verificationByCandidate,
      }),
    )
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        a.lane.localeCompare(b.lane) ||
        a.netuid - b.netuid,
    );
  const queue = fullQueue.map(compactEnrichmentQueueEntry);
  const evidenceEntries = fullQueue.map(enrichmentEvidenceEntry);

  const queueArtifact: Row = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Prioritized enrichment queue derived from public-safe profile gaps, candidate counts, review state, adapter potential, and probe-derived endpoint incidents. It is contributor guidance, not a contribution API.",
    summary: {
      subnet_count: profiles.length,
      queue_count: queue.length,
      direct_submission_count: queue.filter(
        (entry) => entry.lane === "direct-submission",
      ).length,
      maintainer_review_count: queue.filter(
        (entry) => entry.lane === "maintainer-review",
      ).length,
      adapter_candidate_count: queue.filter(
        (entry) => entry.lane === "adapter-candidate",
      ).length,
      monitoring_followup_count: queue.filter(
        (entry) => entry.lane === "monitoring-followup",
      ).length,
      baseline_monitoring_count: queue.filter(
        (entry) => entry.lane === "baseline-monitoring",
      ).length,
      manual_review_required_count: queue.filter(
        (entry) => entry.manual_review_required,
      ).length,
      lane_counts: countBy(queue, "lane"),
      identity_level_counts: countBy(queue, "identity_level"),
      evidence_action_counts: countBy(queue, "evidence_action"),
      top_direct_submission_kinds: countDirectSubmissionKinds(queue),
    },
    queue,
  };
  const evidenceArtifact: Row = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Detailed candidate evidence by missing or contributor-target surface kind. This is contributor guidance and maintainer review context; it does not create registry truth or observed health.",
    entries: evidenceEntries,
    summary: {
      subnet_count: evidenceEntries.length,
      entry_count: evidenceEntries.length,
      evidence_action_counts: countBy(evidenceEntries, "evidence_action"),
      stale_candidate_count: evidenceEntries.reduce(
        (sum, entry) =>
          sum + entry.candidate_evidence_summary.stale_or_failed_count,
        0,
      ),
      unverified_candidate_count: evidenceEntries.reduce(
        (sum, entry) => sum + entry.candidate_evidence_summary.unverified_count,
        0,
      ),
    },
  };
  const targetArtifact = buildEnrichmentTargetsArtifact({
    evidenceEntries,
    queue,
    contractVersion,
    generatedAt,
  });
  return { evidenceArtifact, queueArtifact, targetArtifact };
}

interface EnrichmentCandidatesForSubnetOptions {
  excludedIds: Set<unknown> | undefined;
  excludedUrls: Set<string> | undefined;
  subnetCandidates: Row[];
}

function enrichmentCandidatesForSubnet({
  excludedIds,
  excludedUrls,
  subnetCandidates,
}: EnrichmentCandidatesForSubnetOptions): Row[] {
  const hasExcludedIds = excludedIds && excludedIds.size > 0;
  const hasExcludedUrls = excludedUrls && excludedUrls.size > 0;
  if (!hasExcludedIds && !hasExcludedUrls) {
    return subnetCandidates;
  }
  return subnetCandidates.filter((candidate) => {
    if (hasExcludedIds && excludedIds?.has(candidate.id)) {
      return false;
    }
    if (!hasExcludedUrls) {
      return true;
    }
    const candidateUrl = normalizePublicUrl(candidate.url);
    return !candidateUrl || !excludedUrls?.has(candidateUrl);
  });
}

interface BuildEnrichmentTargetsArtifactOptions {
  evidenceEntries: Row[];
  queue: Row[];
  contractVersion: string;
  generatedAt: string;
}

function buildEnrichmentTargetsArtifact({
  evidenceEntries,
  queue,
  contractVersion,
  generatedAt,
}: BuildEnrichmentTargetsArtifactOptions): Row {
  const evidenceByNetuid = new Map<unknown, Row>(
    evidenceEntries.map((entry) => [entry.netuid, entry]),
  );
  const targets: Row[] = queue
    .flatMap((entry) =>
      enrichmentTargetsForEntry({
        entry,
        evidenceEntry: evidenceByNetuid.get(entry.netuid),
      }),
    )
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        a.target_type.localeCompare(b.target_type) ||
        String(a.kind || "").localeCompare(String(b.kind || "")) ||
        a.netuid - b.netuid,
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Contributor-oriented enrichment target pack derived from the queue and evidence artifacts. It provides public-safe submission guidance only; observed health and registry truth remain probe/generated artifacts.",
    summary: {
      target_count: targets.length,
      subnet_count: new Set(targets.map((target) => target.netuid)).size,
      auto_review_candidate_count: targets.filter(
        (target) => target.auto_review_candidate,
      ).length,
      manual_review_required_count: targets.filter(
        (target) => target.manual_review_required,
      ).length,
      new_evidence_count: targets.filter(
        (target) => target.evidence_action === "submit-new-evidence",
      ).length,
      stale_replacement_count: targets.filter(
        (target) => target.evidence_action === "replace-stale-evidence",
      ).length,
      by_evidence_action: countBy(targets, "evidence_action"),
      by_kind: countBy(
        targets.filter((target) => target.kind),
        "kind",
      ),
      by_lane: countBy(targets, "lane"),
      by_target_type: countBy(targets, "target_type"),
    },
    groups: enrichmentTargetGroups(targets),
    targets,
  };
}

function enrichmentTargetsForEntry({
  entry,
  evidenceEntry,
}: {
  entry: Row;
  evidenceEntry: Row | undefined;
}): Row[] {
  if (entry.lane === "direct-submission") {
    return entry.direct_submission_kinds.map((kind: string) =>
      surfaceCandidateTarget({ entry, evidenceEntry, kind }),
    );
  }
  if (entry.lane === "adapter-candidate") {
    return [
      nonSurfaceEnrichmentTarget({ entry, targetType: "adapter-review" }),
    ];
  }
  if (entry.lane === "maintainer-review") {
    return [
      nonSurfaceEnrichmentTarget({
        entry,
        targetType: "maintainer-review",
      }),
    ];
  }
  return [
    nonSurfaceEnrichmentTarget({
      entry,
      targetType: "monitoring-followup",
    }),
  ];
}

function surfaceCandidateTarget({
  entry,
  evidenceEntry,
  kind,
}: {
  entry: Row;
  evidenceEntry: Row | undefined;
  kind: string;
}): Row {
  const candidateEvidence: Row = evidenceEntry?.candidate_evidence_by_kind?.[
    kind
  ] || {
    candidate_count: 0,
    classifications: {},
    live_or_redirected_count: 0,
    reviewable_count: 0,
    sample_candidate_ids: [],
    stale_or_failed_count: 0,
    unverified_count: 0,
  };
  const evidenceAction = surfaceEvidenceAction(candidateEvidence);
  const action = surfaceTargetAction(evidenceAction);
  return {
    auto_review_candidate: !entry.manual_review_required,
    candidate_command: candidateCommandTemplate(entry.netuid, kind),
    candidate_evidence: candidateEvidence,
    contribution_prompt: contributionPromptForKind(kind, evidenceAction),
    evidence_action: evidenceAction,
    identity_level: entry.identity_level,
    kind,
    lane: entry.lane,
    manual_review_required: entry.manual_review_required,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    profile_level: entry.profile_level,
    queue_context: enrichmentTargetQueueContext(entry),
    reason_codes: entry.reason_codes,
    recommended_action: entry.recommended_action,
    sample_live_candidate_ids: entry.sample_live_candidate_ids,
    sample_stale_candidate_ids: entry.sample_stale_candidate_ids,
    sample_target_candidate_ids: entry.sample_target_candidate_ids,
    slug: entry.slug,
    source_requirements: sourceRequirementsForKind(kind),
    source_urls: entry.source_urls.slice(0, 3),
    submission_route: "direct-candidate-pr",
    target_id: enrichmentTargetId(entry, "surface-candidate", kind),
    target_type: "surface-candidate",
    target_action: action,
  };
}

function surfaceEvidenceAction(candidateEvidence: Row | undefined): string {
  if (!candidateEvidence || candidateEvidence.candidate_count === 0) {
    return "submit-new-evidence";
  }
  if (candidateEvidence.live_or_redirected_count > 0) {
    return "review-existing-evidence";
  }
  if (candidateEvidence.stale_or_failed_count > 0) {
    return "replace-stale-evidence";
  }
  return "verify-existing-evidence";
}

function nonSurfaceEnrichmentTarget({
  entry,
  targetType,
}: {
  entry: Row;
  targetType: string;
}): Row {
  const routeByType: Record<string, string> = {
    "adapter-review": "adapter-request",
    "maintainer-review": "maintainer-review",
    "monitoring-followup": "status-report",
  };
  return {
    auto_review_candidate: false,
    candidate_command: null,
    candidate_evidence: null,
    contribution_prompt: contributionPromptForTargetType(targetType),
    evidence_action: entry.evidence_action,
    identity_level: entry.identity_level,
    kind: null,
    lane: entry.lane,
    manual_review_required: true,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    profile_level: entry.profile_level,
    queue_context: enrichmentTargetQueueContext(entry),
    reason_codes: entry.reason_codes,
    recommended_action: entry.recommended_action,
    sample_live_candidate_ids: entry.sample_live_candidate_ids,
    sample_stale_candidate_ids: entry.sample_stale_candidate_ids,
    sample_target_candidate_ids: entry.sample_target_candidate_ids,
    slug: entry.slug,
    source_requirements: sourceRequirementsForTargetType(targetType),
    source_urls: entry.source_urls.slice(0, 3),
    submission_route: routeByType[targetType],
    target_id: enrichmentTargetId(entry, targetType, null),
    target_type: targetType,
    target_action: targetType,
  };
}

function enrichmentTargetQueueContext(entry: Row): Row {
  return {
    adapter_score: entry.adapter_score,
    candidate_count: entry.candidate_count,
    completeness_score: entry.completeness_score,
    curation_level: entry.curation_level,
    direct_submission_kind_count: entry.direct_submission_kinds.length,
    endpoint_count: entry.endpoint_count,
    identity_surface_count: entry.identity_surface_count,
    operational_interface_count: entry.operational_interface_count,
    profile_level: entry.profile_level,
    review_state: entry.review_state,
    source_url_count: entry.source_urls.length,
    stale_candidate_count: entry.stale_candidate_count,
    surface_count: entry.surface_count,
    verified_candidate_count: entry.verified_candidate_count,
  };
}

function enrichmentTargetGroups(targets: Row[]): Row[] {
  return [...groupBy(targets, "target_type").entries()]
    .flatMap(([targetType, rows]) => {
      const byKind = groupBy(rows, (row) => row.kind || targetType);
      return [...byKind.entries()].map(([kind, kindRows]) => ({
        auto_review_candidate_count: kindRows.filter(
          (target) => target.auto_review_candidate,
        ).length,
        kind: kind === targetType ? null : kind,
        manual_review_required_count: kindRows.filter(
          (target) => target.manual_review_required,
        ).length,
        target_count: kindRows.length,
        target_ids: kindRows.map((target) => target.target_id).slice(0, 20),
        target_type: targetType,
        top_netuids: kindRows
          .slice()
          .sort(
            (a, b) =>
              b.priority_score - a.priority_score || a.netuid - b.netuid,
          )
          .slice(0, 10)
          .map((target) => target.netuid),
      }));
    })
    .sort(
      (a, b) =>
        String(a.target_type).localeCompare(String(b.target_type)) ||
        String(a.kind || "").localeCompare(String(b.kind || "")),
    );
}

function enrichmentTargetId(
  entry: Row,
  targetType: string,
  kind: string | null,
): string {
  return [`sn-${entry.netuid}`, targetType, kind || entry.lane]
    .map(slugify)
    .join("-");
}

function candidateCommandTemplate(netuid: unknown, kind: string): string {
  return `npm run surface:add -- --netuid ${netuid} --kind ${kind} --url <public-url> --source-url <public-source-url> --provider <provider-slug> --submitted-by <github-login> --write`;
}

function surfaceTargetAction(evidenceAction: string): string {
  if (evidenceAction === "replace-stale-evidence") {
    return "replace-stale-candidate";
  }
  if (evidenceAction === "verify-existing-evidence") {
    return "verify-existing-candidate";
  }
  if (evidenceAction === "review-existing-evidence") {
    return "review-existing-candidate";
  }
  return "submit-new-candidate";
}

function contributionPromptForKind(
  kind: string,
  evidenceAction: string,
): string {
  const verb =
    evidenceAction === "replace-stale-evidence"
      ? "Replace stale or failed"
      : evidenceAction === "review-existing-evidence"
        ? "Confirm and submit"
        : "Submit";
  return `${verb} official public ${kind} evidence for this subnet. Use one candidate per PR and include a public source URL that proves provenance.`;
}

function contributionPromptForTargetType(targetType: string): string {
  if (targetType === "adapter-review") {
    return "Review whether the existing public API/schema/data surfaces justify a subnet-specific adapter. Adapter requests route to manual review.";
  }
  if (targetType === "maintainer-review") {
    return "Review existing machine-verified surfaces and promote only source-backed public interfaces.";
  }
  return "Review probe-derived status or request a re-probe. Contributor reports never set observed health directly.";
}

function sourceRequirementsForKind(kind: string): string[] {
  if (["website", "docs", "source-repo"].includes(kind)) {
    return [
      "Prefer an official project/team source.",
      "The source URL must be public and show the subnet/project relationship.",
      "Do not submit Discord-only claims, private dashboards, wallet paths, PATs, or validator internals.",
    ];
  }
  if (["openapi", "subnet-api", "sse", "data-artifact"].includes(kind)) {
    return [
      "The URL must be public-safe and read-only.",
      "The source URL must document or link the interface.",
      "Do not submit authenticated, write-capable, wallet, PAT, or validator-private flows.",
    ];
  }
  return [
    "The URL and source URL must both be public.",
    "The source URL must explain ownership or relevance.",
    "Do not submit secrets, private URLs, wallet paths, or validator internals.",
  ];
}

function sourceRequirementsForTargetType(targetType: string): string[] {
  if (targetType === "adapter-review") {
    return [
      "Existing public API/schema/data evidence should be stable enough to normalize.",
      "Adapter work requires maintainer review before publication.",
    ];
  }
  if (targetType === "maintainer-review") {
    return [
      "Use public provenance to confirm or reject existing machine-verified surfaces.",
      "Promotion decisions must stay public-safe and source-backed.",
    ];
  }
  return [
    "Use status reports to trigger review or re-probes only.",
    "Observed uptime, latency, and incidents remain probe-derived.",
  ];
}

function compactEnrichmentQueueEntry(entry: Row): Row {
  const { candidate_evidence_by_kind: evidenceByKind, ...compact } = entry;
  return {
    ...compact,
    candidate_evidence_summary: summarizeCandidateEvidence(evidenceByKind),
  };
}

function enrichmentEvidenceEntry(entry: Row): Row {
  return {
    candidate_evidence_by_kind: entry.candidate_evidence_by_kind,
    candidate_evidence_summary: summarizeCandidateEvidence(
      entry.candidate_evidence_by_kind,
    ),
    direct_submission_kinds: entry.direct_submission_kinds,
    evidence_action: entry.evidence_action,
    lane: entry.lane,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    slug: entry.slug,
  };
}

function summarizeCandidateEvidence(evidenceByKind: Row | undefined): Row {
  const entries = Object.entries(evidenceByKind || {});
  const summary: Row = {
    candidate_count: 0,
    kinds_with_candidates: [],
    live_kinds: [],
    live_or_redirected_count: 0,
    reviewable_count: 0,
    stale_kinds: [],
    stale_or_failed_count: 0,
    unverified_count: 0,
    unverified_kinds: [],
  };

  for (const [kind, evidence] of entries as [string, Row][]) {
    summary.candidate_count += evidence.candidate_count || 0;
    summary.live_or_redirected_count += evidence.live_or_redirected_count || 0;
    summary.reviewable_count += evidence.reviewable_count || 0;
    summary.stale_or_failed_count += evidence.stale_or_failed_count || 0;
    summary.unverified_count += evidence.unverified_count || 0;
    if ((evidence.candidate_count || 0) > 0) {
      summary.kinds_with_candidates.push(kind);
    }
    if ((evidence.live_or_redirected_count || 0) > 0) {
      summary.live_kinds.push(kind);
    }
    if ((evidence.stale_or_failed_count || 0) > 0) {
      summary.stale_kinds.push(kind);
    }
    if ((evidence.unverified_count || 0) > 0) {
      summary.unverified_kinds.push(kind);
    }
  }

  summary.kinds_with_candidates.sort();
  summary.live_kinds.sort();
  summary.stale_kinds.sort();
  summary.unverified_kinds.sort();
  return summary;
}

interface EnrichmentQueueEntryOptions {
  adapterCandidate: Row | undefined;
  gapPriority: Row | undefined;
  profile: Row;
  reviewProfile: Row | undefined;
  subnetCandidates: Row[];
  verificationByCandidate: Map<unknown, Row>;
}

function enrichmentQueueEntry({
  adapterCandidate,
  gapPriority,
  profile,
  reviewProfile,
  subnetCandidates,
  verificationByCandidate,
}: EnrichmentQueueEntryOptions): Row {
  const missingRequired = profile.completeness.missing_required || [];
  const missingOperational = profile.completeness.missing_operational || [];
  const missingKinds = [
    ...new Set([
      ...(gapPriority?.missing_kinds || []),
      ...missingRequired,
      ...missingOperational,
    ]),
  ].sort();
  const directSubmissionKinds = directSubmissionKindsForProfile(profile);
  const candidateEvidenceByKind = candidateEvidenceByKindForQueue({
    directSubmissionKinds,
    missingKinds,
    subnetCandidates,
    verificationByCandidate,
  });
  const lane = enrichmentLane({
    adapterCandidate,
    directSubmissionKinds,
    profile,
  });
  const evidenceAction = enrichmentEvidenceAction({
    candidateEvidenceByKind,
    directSubmissionKinds,
    lane,
  });
  const manualReviewRequired = [
    "maintainer-review",
    "adapter-candidate",
  ].includes(lane);
  const adapterScore = adapterCandidate?.priority_score || 0;
  const priorityScore =
    (reviewProfile?.priority_score || 100 - profile.completeness_score) +
    Math.floor((gapPriority?.priority_score || 0) / 2) +
    Math.floor(adapterScore / 2);

  return {
    adapter_score: adapterScore,
    candidate_evidence_by_kind: candidateEvidenceByKind,
    candidate_count: profile.candidate_count,
    completeness_score: profile.completeness_score,
    contribution_hint: enrichmentContributionHint(lane, directSubmissionKinds),
    curation_level: profile.curation_level,
    direct_submission_kinds: directSubmissionKinds,
    endpoint_count: profile.endpoint_count,
    evidence_action: evidenceAction,
    identity_level: profile.identity_level,
    identity_surface_count: profile.identity_surface_count,
    lane,
    manual_review_required: manualReviewRequired,
    missing_identity: profile.missing_identity,
    missing_kinds: missingKinds,
    name: profile.name,
    netuid: profile.netuid,
    operational_interface_count: profile.operational_interface_count,
    priority_score: priorityScore,
    profile_level: profile.profile_level,
    reason_codes: enrichmentReasonCodes({
      adapterCandidate,
      directSubmissionKinds,
      profile,
    }),
    recommended_action: enrichmentRecommendedAction({
      adapterCandidate,
      directSubmissionKinds,
      lane,
      profile,
      reviewProfile,
    }),
    review_state: profile.review_state,
    sample_candidate_ids: subnetCandidates
      .map((candidate) => candidate.id)
      .filter(Boolean)
      .sort()
      .slice(0, 5),
    sample_live_candidate_ids: sampleCandidateIdsForQueue({
      candidateClasses: ["live", "redirected"],
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    sample_stale_candidate_ids: sampleCandidateIdsForQueue({
      candidateClasses: [
        "content-mismatch",
        "dead",
        "timeout",
        "unsafe",
        "unsupported",
      ],
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    sample_target_candidate_ids: sampleCandidateIdsForQueue({
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    slug: profile.slug,
    source_urls: (profile.provenance.source_urls || []).slice(0, 8),
    stale_candidate_count: staleCandidateCount(candidateEvidenceByKind),
    surface_count: profile.surface_count,
    verified_candidate_count: gapPriority?.verified_candidate_count || 0,
  };
}

interface CandidateEvidenceByKindForQueueOptions {
  directSubmissionKinds: string[];
  missingKinds: string[];
  subnetCandidates: Row[];
  verificationByCandidate: Map<unknown, Row>;
}

function candidateEvidenceByKindForQueue({
  directSubmissionKinds,
  missingKinds,
  subnetCandidates,
  verificationByCandidate,
}: CandidateEvidenceByKindForQueueOptions): Row {
  const relevantKinds = [
    ...new Set([...missingKinds, ...directSubmissionKinds]),
  ].sort();
  const candidatesByKind = groupBy(
    subnetCandidates.filter((candidate) =>
      relevantKinds.includes(candidate.kind),
    ),
    "kind",
  );

  return Object.fromEntries(
    relevantKinds.map((kind) => {
      const kindCandidates = candidatesByKind.get(kind) || [];
      const classifications = countBy(
        kindCandidates.map((candidate) => ({
          classification:
            verificationByCandidate.get(candidate.id)?.classification ||
            candidate.verification?.classification ||
            candidate.state ||
            "unknown",
        })),
        "classification",
      );
      const liveCount =
        (classifications.live || 0) + (classifications.redirected || 0);
      const unverifiedCount =
        (classifications["schema-valid"] || 0) +
        (classifications["maintainer-review"] || 0) +
        (classifications.verified || 0) +
        (classifications.unknown || 0);
      const deadCount =
        (classifications.dead || 0) +
        (classifications.timeout || 0) +
        (classifications.unsafe || 0) +
        (classifications.unsupported || 0) +
        (classifications["content-mismatch"] || 0);
      const reviewableCount = kindCandidates.filter((candidate) =>
        ["schema-valid", "maintainer-review", "verified"].includes(
          candidate.state,
        ),
      ).length;
      return [
        kind,
        {
          candidate_count: kindCandidates.length,
          classifications,
          live_or_redirected_count: liveCount,
          reviewable_count: reviewableCount,
          stale_or_failed_count: deadCount,
          unverified_count: unverifiedCount,
          sample_candidate_ids: kindCandidates
            .map((candidate) => candidate.id)
            .filter(Boolean)
            .sort()
            .slice(0, 3),
        },
      ];
    }),
  );
}

interface SampleCandidateIdsForQueueOptions {
  candidateClasses?: string[] | null;
  directSubmissionKinds: string[];
  missingKinds: string[];
  subnetCandidates: Row[];
  verificationByCandidate: Map<unknown, Row>;
}

function sampleCandidateIdsForQueue({
  candidateClasses = null,
  directSubmissionKinds,
  missingKinds,
  subnetCandidates,
  verificationByCandidate,
}: SampleCandidateIdsForQueueOptions): string[] {
  const relevantKinds = new Set(
    directSubmissionKinds.length > 0 ? directSubmissionKinds : missingKinds,
  );
  const classSet = candidateClasses ? new Set(candidateClasses) : null;
  return subnetCandidates
    .filter((candidate) => relevantKinds.has(candidate.kind))
    .filter((candidate) => {
      if (!classSet) {
        return true;
      }
      return classSet.has(
        candidateQueueClassification(candidate, verificationByCandidate),
      );
    })
    .sort(
      (a, b) =>
        candidateQueuePriority(a, verificationByCandidate) -
          candidateQueuePriority(b, verificationByCandidate) ||
        a.kind.localeCompare(b.kind) ||
        String(a.id || "").localeCompare(String(b.id || "")),
    )
    .map((candidate) => candidate.id)
    .filter(Boolean)
    .slice(0, 5);
}

function candidateQueueClassification(
  candidate: Row,
  verificationByCandidate: Map<unknown, Row>,
): string {
  return (
    verificationByCandidate.get(candidate.id)?.classification ||
    candidate.verification?.classification ||
    candidate.state ||
    "unknown"
  );
}

function candidateQueuePriority(
  candidate: Row,
  verificationByCandidate: Map<unknown, Row>,
): number {
  const classification = candidateQueueClassification(
    candidate,
    verificationByCandidate,
  );
  const weights: Record<string, number> = {
    live: 0,
    redirected: 1,
    verified: 2,
    "maintainer-review": 3,
    "schema-valid": 4,
    unknown: 5,
    "auth-required": 6,
    "rate-limited": 7,
    timeout: 8,
    "content-mismatch": 9,
    unsupported: 10,
    dead: 11,
    unsafe: 12,
    rejected: 13,
  };
  return weights[classification] ?? 20;
}

interface EnrichmentEvidenceActionOptions {
  candidateEvidenceByKind: Row;
  directSubmissionKinds: string[];
  lane: string;
}

function enrichmentEvidenceAction({
  candidateEvidenceByKind,
  directSubmissionKinds,
  lane,
}: EnrichmentEvidenceActionOptions): string {
  if (["adapter-candidate", "maintainer-review"].includes(lane)) {
    return "maintainer-review-existing-evidence";
  }
  if (lane !== "direct-submission") {
    return "monitor";
  }

  const targetEvidence = directSubmissionKinds.map(
    (kind) => candidateEvidenceByKind[kind],
  );
  if (
    targetEvidence.some(
      (evidence) =>
        evidence &&
        evidence.candidate_count > 0 &&
        evidence.live_or_redirected_count === 0,
    )
  ) {
    if (
      targetEvidence.some(
        (evidence) => evidence && evidence.stale_or_failed_count > 0,
      )
    ) {
      return "replace-stale-evidence";
    }
    return "verify-existing-evidence";
  }
  if (
    targetEvidence.some(
      (evidence) => evidence && evidence.live_or_redirected_count > 0,
    )
  ) {
    return "review-existing-evidence";
  }
  return "submit-new-evidence";
}

function staleCandidateCount(candidateEvidenceByKind: Row): number {
  return Object.values(candidateEvidenceByKind).reduce(
    (sum: number, evidence) =>
      sum + ((evidence as Row).stale_or_failed_count || 0),
    0,
  );
}

export function directSubmissionKindsForProfile(profile: Row): string[] {
  const missingRequired = new Set(profile.completeness.missing_required || []);
  const identityTargets = ["docs", "website", "source-repo"].filter((kind) =>
    missingRequired.has(kind),
  );
  if (identityTargets.length > 0) {
    return identityTargets;
  }

  const missingOperational = new Set(
    profile.completeness.missing_operational || [],
  );
  const hasOperationalEvidence = profile.operational_interface_count > 0;
  const operationalTargets = ["openapi", "subnet-api", "data-artifact"].filter(
    (kind) => missingOperational.has(kind),
  );
  if (!hasOperationalEvidence) {
    return operationalTargets;
  }

  const hasApiLikeEvidence = (
    profile.operational_interface_kinds as string[]
  ).some((kind) => ["openapi", "subnet-api"].includes(kind));
  if (!hasApiLikeEvidence) {
    return operationalTargets.filter((kind) =>
      ["openapi", "subnet-api"].includes(kind),
    );
  }

  return [];
}

interface EnrichmentLaneOptions {
  adapterCandidate: Row | undefined;
  directSubmissionKinds: string[];
  profile: Row;
}

function enrichmentLane({
  adapterCandidate,
  directSubmissionKinds,
  profile,
}: EnrichmentLaneOptions): string {
  if (directSubmissionKinds.length > 0) {
    return "direct-submission";
  }
  if (
    profile.review_state !== "maintainer-reviewed" &&
    profile.surface_count > 0
  ) {
    return "maintainer-review";
  }
  if (adapterCandidate?.operational_surface_count > 0) {
    return "adapter-candidate";
  }
  return "baseline-monitoring";
}

interface EnrichmentReasonCodesOptions {
  adapterCandidate: Row | undefined;
  directSubmissionKinds: string[];
  profile: Row;
}

function enrichmentReasonCodes({
  adapterCandidate,
  directSubmissionKinds,
  profile,
}: EnrichmentReasonCodesOptions): string[] {
  const reasons: string[] = [];
  if (profile.profile_level === "directory-only") {
    reasons.push("directory-only-profile");
  }
  for (const kind of directSubmissionKinds) {
    reasons.push(`missing-${kind}`);
  }
  if (profile.review_state !== "maintainer-reviewed") {
    reasons.push("needs-maintainer-review");
  }
  if (adapterCandidate?.operational_surface_count > 0) {
    reasons.push("adapter-candidate");
  }
  return [...new Set(reasons)].sort();
}

function enrichmentContributionHint(
  lane: string,
  directSubmissionKinds: string[],
): string {
  if (lane === "direct-submission") {
    const kinds = directSubmissionKinds.join(", ");
    return `Submit one official public ${kinds || "interface"} candidate with npm run surface:add.`;
  }
  if (lane === "maintainer-review") {
    return "Maintainer should review current machine-verified surfaces and promote only source-backed entries.";
  }
  if (lane === "adapter-candidate") {
    return "Maintainer should evaluate whether subnet-specific adapter metrics add useful public operational data.";
  }
  if (lane === "monitoring-followup") {
    return "Endpoint status reports can trigger re-probes or review, but observed health remains probe-derived.";
  }
  return "No immediate enrichment action; keep monitoring for drift and new public interfaces.";
}

interface EnrichmentRecommendedActionOptions {
  adapterCandidate: Row | undefined;
  directSubmissionKinds: string[];
  lane: string;
  profile: Row;
  reviewProfile: Row | undefined;
}

function enrichmentRecommendedAction({
  adapterCandidate,
  directSubmissionKinds,
  lane,
  profile,
  reviewProfile,
}: EnrichmentRecommendedActionOptions): string {
  if (lane === "direct-submission") {
    if (
      directSubmissionKinds.some((kind) =>
        ["docs", "website", "source-repo"].includes(kind),
      )
    ) {
      return "submit official docs, website, or source repository evidence";
    }
    return "submit public API, OpenAPI, SSE, or data-artifact surfaces if the subnet exposes them";
  }
  if (lane === "maintainer-review") {
    return (
      reviewProfile?.suggested_next_action ||
      "review promoted surfaces and mark maintainer-reviewed where provenance is strong"
    );
  }
  if (lane === "adapter-candidate") {
    const kinds = (adapterCandidate?.operational_kinds || []).join(", ");
    return `evaluate adapter support for ${kinds || "operational surfaces"}`;
  }
  if (profile.operational_interface_count > 0) {
    return "profile is baseline-complete; monitor operational surfaces for drift";
  }
  return "profile is baseline-complete; monitor for new public interfaces";
}

function countDirectSubmissionKinds(queue: Row[]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      queue.reduce((accumulator: Record<string, number>, entry) => {
        for (const kind of entry.direct_submission_kinds || []) {
          accumulator[kind] = (accumulator[kind] || 0) + 1;
        }
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
