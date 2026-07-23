import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildEnrichmentQueueArtifacts,
  directSubmissionKindsForProfile,
} from "../scripts/lib/enrichment-queue-artifacts.ts";

const GENERATED_AT = "2026-06-25T00:00:00.000Z";
const CONTRACT = "test-contract";

// --- directSubmissionKindsForProfile ----------------------------------------

function completeness({ required = [], operational = [] } = {}) {
  return { missing_required: required, missing_operational: operational };
}

describe("directSubmissionKindsForProfile", () => {
  test("missing identity surfaces take priority and preserve canonical order", () => {
    assert.deepEqual(
      directSubmissionKindsForProfile({
        completeness: completeness({ required: ["source-repo", "docs"] }),
        operational_interface_count: 0,
        operational_interface_kinds: [],
      }),
      ["docs", "source-repo"],
    );
  });

  test("with no operational evidence, returns all missing operational kinds", () => {
    assert.deepEqual(
      directSubmissionKindsForProfile({
        completeness: completeness({
          operational: ["subnet-api", "data-artifact", "openapi"],
        }),
        operational_interface_count: 0,
        operational_interface_kinds: [],
      }),
      ["openapi", "subnet-api", "data-artifact"],
    );
  });

  test("with non-API operational evidence, narrows to API-like missing kinds", () => {
    assert.deepEqual(
      directSubmissionKindsForProfile({
        completeness: completeness({
          operational: ["openapi", "data-artifact"],
        }),
        operational_interface_count: 1,
        operational_interface_kinds: ["data-artifact"],
      }),
      ["openapi"],
    );
  });

  test("with API-like operational evidence, asks for nothing", () => {
    assert.deepEqual(
      directSubmissionKindsForProfile({
        completeness: completeness({ operational: [] }),
        operational_interface_count: 1,
        operational_interface_kinds: ["subnet-api"],
      }),
      [],
    );
  });

  test("a fully-covered profile asks for nothing", () => {
    assert.deepEqual(
      directSubmissionKindsForProfile({
        completeness: completeness(),
        operational_interface_count: 0,
        operational_interface_kinds: [],
      }),
      [],
    );
  });
});

// --- buildEnrichmentQueueArtifacts ------------------------------------------

function profile(netuid, overrides = {}) {
  return {
    netuid,
    slug: `sn-${netuid}`,
    name: `Subnet ${netuid}`,
    completeness: completeness(),
    completeness_score: 50,
    candidate_count: 0,
    curation_level: "community",
    endpoint_count: 0,
    identity_level: "basic",
    identity_surface_count: 0,
    missing_identity: [],
    operational_interface_count: 0,
    operational_interface_kinds: [],
    profile_level: "basic",
    review_state: "community-submitted",
    surface_count: 0,
    provenance: { source_urls: [] },
    ...overrides,
  };
}

function buildAll(input) {
  return buildEnrichmentQueueArtifacts({
    candidates: [],
    curationReview: { gap_priorities: [], adapter_candidates: [] },
    profiles: [],
    reviewProfiles: [],
    subnets: [],
    verification: { results: [] },
    contractVersion: CONTRACT,
    generatedAt: GENERATED_AT,
    ...input,
  });
}

describe("buildEnrichmentQueueArtifacts", () => {
  test("empty inputs produce well-formed, empty artifacts", () => {
    const { queueArtifact, evidenceArtifact, targetArtifact } = buildAll({});
    assert.equal(queueArtifact.schema_version, 1);
    assert.equal(queueArtifact.contract_version, CONTRACT);
    assert.equal(queueArtifact.generated_at, GENERATED_AT);
    assert.deepEqual(queueArtifact.queue, []);
    assert.equal(queueArtifact.summary.subnet_count, 0);
    assert.equal(queueArtifact.summary.queue_count, 0);
    assert.deepEqual(evidenceArtifact.entries, []);
    assert.equal(evidenceArtifact.summary.entry_count, 0);
    assert.deepEqual(targetArtifact.targets, []);
    assert.equal(targetArtifact.summary.target_count, 0);
  });

  test("routes each profile to its lane and evidence action", () => {
    const profiles = [
      // direct-submission via missing identity; live candidate → review evidence.
      profile(1, {
        completeness: completeness({ required: ["docs"] }),
        candidate_count: 1,
        profile_level: "directory-only",
        provenance: { source_urls: ["https://a.example.com"] },
      }),
      // direct-submission via missing operational (no evidence); stale candidates.
      profile(2, {
        completeness: completeness({ operational: ["subnet-api", "openapi"] }),
        candidate_count: 3,
      }),
      // direct-submission narrowed to API-like; unverified candidate → verify.
      profile(3, {
        completeness: completeness({ operational: ["openapi"] }),
        operational_interface_count: 1,
        operational_interface_kinds: ["data-artifact"],
        candidate_count: 1,
      }),
      // maintainer-review: covered, unreviewed, has surfaces.
      profile(4, {
        operational_interface_count: 1,
        operational_interface_kinds: ["subnet-api"],
        surface_count: 2,
        review_state: "community-submitted",
      }),
      // adapter-candidate: covered + reviewed, adapter potential.
      profile(5, {
        operational_interface_count: 1,
        operational_interface_kinds: ["subnet-api"],
        surface_count: 2,
        review_state: "maintainer-reviewed",
      }),
      // baseline-monitoring with operational evidence (drift).
      profile(6, {
        operational_interface_count: 1,
        operational_interface_kinds: ["subnet-api"],
        surface_count: 1,
        review_state: "maintainer-reviewed",
      }),
      // baseline-monitoring with no operational evidence (new interfaces).
      profile(7, {
        review_state: "maintainer-reviewed",
      }),
      // direct-submission identity (website) with no candidate evidence → submit-new.
      profile(8, {
        completeness: completeness({ required: ["website"] }),
      }),
    ];
    const candidates = [
      {
        // Own classification "dead"; the overlay (below) reclassifies it "live".
        id: "c-a1",
        netuid: 1,
        kind: "docs",
        url: "https://a.example.com/docs",
        state: "dead",
        verification: { classification: "dead" },
      },
      {
        id: "c-b1",
        netuid: 2,
        kind: "subnet-api",
        url: "https://b.example.com/api1",
        state: "dead",
        verification: { classification: "dead" },
      },
      {
        id: "c-b3",
        netuid: 2,
        kind: "subnet-api",
        url: "https://b.example.com/api2",
        state: "timeout",
        verification: { classification: "timeout" },
      },
      // No state / no verification → "unknown" classification (the final fallback).
      {
        id: "c-b4",
        netuid: 2,
        kind: "subnet-api",
        url: "https://b.example.com/api3",
      },
      // Classification falls back to candidate.state.
      {
        id: "c-c1",
        netuid: 3,
        kind: "openapi",
        url: "https://c.example.com/openapi.json",
        state: "schema-valid",
      },
    ];
    const { queueArtifact, evidenceArtifact, targetArtifact } = buildAll({
      profiles,
      candidates,
      curationReview: {
        gap_priorities: [
          {
            netuid: 1,
            missing_kinds: ["docs"],
            priority_score: 20,
            verified_candidate_count: 2,
          },
        ],
        adapter_candidates: [
          {
            netuid: 5,
            operational_surface_count: 2,
            priority_score: 50,
            operational_kinds: ["subnet-api"],
          },
        ],
      },
      reviewProfiles: [
        {
          netuid: 4,
          priority_score: 80,
          suggested_next_action: "promote the verified surface",
        },
      ],
      // Overlay outranks the candidate's own classification (c-a1: dead → live).
      verification: {
        results: [{ candidate_id: "c-a1", classification: "live" }],
      },
    });

    const byNetuid = new Map(
      queueArtifact.queue.map((entry) => [entry.netuid, entry]),
    );

    assert.equal(byNetuid.get(1).lane, "direct-submission");
    assert.deepEqual(byNetuid.get(1).direct_submission_kinds, ["docs"]);
    assert.equal(byNetuid.get(1).evidence_action, "review-existing-evidence");
    assert.ok(byNetuid.get(1).reason_codes.includes("directory-only-profile"));
    assert.ok(byNetuid.get(1).reason_codes.includes("missing-docs"));
    assert.equal(byNetuid.get(1).verified_candidate_count, 2);
    // Live only via the overlay (c-a1's own classification is "dead").
    assert.deepEqual(byNetuid.get(1).sample_live_candidate_ids, ["c-a1"]);

    assert.equal(byNetuid.get(2).lane, "direct-submission");
    assert.deepEqual(byNetuid.get(2).direct_submission_kinds, [
      "openapi",
      "subnet-api",
    ]);
    assert.equal(byNetuid.get(2).evidence_action, "replace-stale-evidence");
    // Exactly 2: c-b1 (dead) + c-b3 (timeout); c-b4 is "unknown", not stale.
    assert.equal(byNetuid.get(2).stale_candidate_count, 2);
    assert.deepEqual(byNetuid.get(2).sample_stale_candidate_ids.sort(), [
      "c-b1",
      "c-b3",
    ]);

    assert.equal(byNetuid.get(3).lane, "direct-submission");
    assert.deepEqual(byNetuid.get(3).direct_submission_kinds, ["openapi"]);
    assert.equal(byNetuid.get(3).evidence_action, "verify-existing-evidence");

    assert.equal(byNetuid.get(4).lane, "maintainer-review");
    assert.equal(byNetuid.get(4).manual_review_required, true);
    assert.equal(
      byNetuid.get(4).evidence_action,
      "maintainer-review-existing-evidence",
    );
    assert.equal(
      byNetuid.get(4).recommended_action,
      "promote the verified surface",
    );
    assert.equal(byNetuid.get(4).priority_score, 80);

    assert.equal(byNetuid.get(5).lane, "adapter-candidate");
    assert.equal(byNetuid.get(5).manual_review_required, true);
    assert.equal(byNetuid.get(5).adapter_score, 50);
    assert.equal(
      byNetuid.get(5).recommended_action,
      "evaluate adapter support for subnet-api",
    );

    assert.equal(byNetuid.get(6).lane, "baseline-monitoring");
    assert.equal(byNetuid.get(6).evidence_action, "monitor");
    assert.ok(byNetuid.get(6).recommended_action.includes("drift"));

    assert.equal(byNetuid.get(7).lane, "baseline-monitoring");
    assert.ok(
      byNetuid.get(7).recommended_action.includes("new public interfaces"),
    );

    assert.equal(byNetuid.get(8).lane, "direct-submission");
    assert.deepEqual(byNetuid.get(8).direct_submission_kinds, ["website"]);
    assert.equal(byNetuid.get(8).evidence_action, "submit-new-evidence");

    // Queue summary reconciles with the lanes above.
    assert.equal(queueArtifact.summary.subnet_count, 8);
    assert.equal(queueArtifact.summary.queue_count, 8);
    assert.equal(queueArtifact.summary.direct_submission_count, 4);
    assert.equal(queueArtifact.summary.maintainer_review_count, 1);
    assert.equal(queueArtifact.summary.adapter_candidate_count, 1);
    assert.equal(queueArtifact.summary.baseline_monitoring_count, 2);
    assert.equal(queueArtifact.summary.manual_review_required_count, 2);
    assert.deepEqual(queueArtifact.summary.lane_counts, {
      "adapter-candidate": 1,
      "baseline-monitoring": 2,
      "direct-submission": 4,
      "maintainer-review": 1,
    });
    assert.deepEqual(queueArtifact.summary.top_direct_submission_kinds, {
      docs: 1,
      openapi: 2,
      "subnet-api": 1,
      website: 1,
    });

    // Queue is sorted by priority_score descending.
    for (let i = 1; i < queueArtifact.queue.length; i += 1) {
      assert.ok(
        queueArtifact.queue[i - 1].priority_score >=
          queueArtifact.queue[i].priority_score,
      );
    }

    // Evidence artifact mirrors one entry per queued subnet.
    assert.equal(evidenceArtifact.entries.length, 8);
    assert.equal(evidenceArtifact.summary.entry_count, 8);
    assert.equal(evidenceArtifact.summary.subnet_count, 8);

    // Targets artifact: one surface-candidate target per direct-submission kind,
    // and one non-surface target per other lane.
    assert.equal(targetArtifact.summary.target_count, 9);
    assert.equal(targetArtifact.summary.subnet_count, 8);
    assert.deepEqual(targetArtifact.summary.by_target_type, {
      "adapter-review": 1,
      "maintainer-review": 1,
      "monitoring-followup": 2,
      "surface-candidate": 5,
    });
    assert.equal(targetArtifact.summary.auto_review_candidate_count, 5);
    assert.equal(targetArtifact.summary.manual_review_required_count, 4);

    const docsTarget = targetArtifact.targets.find(
      (target) => target.netuid === 1 && target.kind === "docs",
    );
    assert.equal(docsTarget.target_type, "surface-candidate");
    assert.equal(docsTarget.submission_route, "direct-candidate-pr");
    assert.equal(docsTarget.auto_review_candidate, true);
    assert.ok(
      docsTarget.candidate_command.includes(
        "npm run surface:add -- --netuid 1 --kind docs",
      ),
    );
    // docs is an identity kind → identity-flavored source requirements.
    assert.ok(
      docsTarget.source_requirements.some((line) =>
        line.includes("official project/team source"),
      ),
    );

    const adapterTarget = targetArtifact.targets.find(
      (target) => target.target_type === "adapter-review",
    );
    assert.equal(adapterTarget.netuid, 5);
    assert.equal(adapterTarget.manual_review_required, true);
    assert.equal(adapterTarget.candidate_command, null);
    assert.equal(adapterTarget.submission_route, "adapter-request");

    // Target groups are present and grouped by target_type/kind.
    assert.ok(Array.isArray(targetArtifact.groups));
    assert.ok(targetArtifact.groups.length > 0);
  });

  test("respects per-subnet baseline exclusions by id and by url", () => {
    const { queueArtifact, evidenceArtifact } = buildAll({
      profiles: [
        profile(10, { completeness: completeness({ required: ["docs"] }) }),
      ],
      candidates: [
        {
          id: "c-x",
          netuid: 10,
          kind: "docs",
          url: "https://x.example.com/docs",
          state: "live",
          verification: { classification: "live" },
        },
        {
          id: "c-y",
          netuid: 10,
          kind: "docs",
          url: "https://y.example.com/docs",
          state: "live",
          verification: { classification: "live" },
        },
        {
          id: "c-z",
          netuid: 10,
          kind: "docs",
          url: "https://z.example.com/docs",
          state: "live",
          verification: { classification: "live" },
        },
      ],
      subnets: [
        {
          netuid: 10,
          baseline_excluded_surface_ids: ["c-x"],
          baseline_excluded_surface_urls: ["https://y.example.com/docs"],
        },
      ],
    });

    const entry = queueArtifact.queue[0];
    // c-x excluded by id, c-y excluded by url → only c-z survives.
    assert.deepEqual(entry.sample_candidate_ids, ["c-z"]);
    const evidence = evidenceArtifact.entries[0];
    assert.equal(evidence.candidate_evidence_by_kind.docs.candidate_count, 1);
    assert.deepEqual(
      evidence.candidate_evidence_by_kind.docs.sample_candidate_ids,
      ["c-z"],
    );
  });

  test("buckets candidate classifications and orders samples by liveness weight", () => {
    const cand = (id, classification, state) => ({
      id,
      netuid: 20,
      kind: "subnet-api",
      url: `https://e.example.com/${id}`,
      ...(state ? { state } : {}),
      verification: { classification },
    });
    const { queueArtifact, evidenceArtifact } = buildAll({
      profiles: [
        profile(20, {
          completeness: completeness({ operational: ["subnet-api"] }),
          candidate_count: 15,
        }),
      ],
      candidates: [
        cand("k1", "redirected", "verified"), // live bucket + reviewable
        cand("k2", "live", "verified"), // live bucket + reviewable
        cand("k3", "schema-valid", "schema-valid"), // unverified + reviewable
        cand("k4", "maintainer-review", "maintainer-review"), // unverified + reviewable
        cand("k5", "verified", "verified"), // unverified + reviewable
        cand("k6", "unknown"), // unverified (unknown)
        cand("k7", "content-mismatch", "dead"), // stale bucket
        cand("k8", "unsafe", "dead"), // stale bucket
        cand("k9", "unsupported", "dead"), // stale bucket
        cand("k10", "timeout", "dead"), // stale bucket
        cand("k11", "dead", "dead"), // stale bucket
        cand("k12", "auth-required"), // priority weight only
        cand("k13", "rate-limited"), // priority weight only
        cand("k14", "rejected"), // priority weight only
        cand("k15", "totally-bogus"), // unknown priority weight (?? fallback)
      ],
    });

    const entry = queueArtifact.queue[0];
    assert.equal(entry.lane, "direct-submission");
    assert.equal(entry.evidence_action, "review-existing-evidence");

    const evidence =
      evidenceArtifact.entries[0].candidate_evidence_by_kind["subnet-api"];
    assert.equal(evidence.candidate_count, 15);
    assert.equal(evidence.live_or_redirected_count, 2); // live + redirected
    assert.equal(evidence.stale_or_failed_count, 5); // dead/timeout/unsafe/unsupported/content-mismatch
    assert.equal(evidence.unverified_count, 4); // schema-valid + maintainer-review + verified + unknown
    assert.equal(evidence.reviewable_count, 5); // state ∈ schema-valid/maintainer-review/verified

    // Live samples sort by liveness weight (live=0 ahead of redirected=1).
    assert.deepEqual(entry.sample_live_candidate_ids, ["k2", "k1"]);
    // Stale samples sort by failure weight: timeout < content-mismatch <
    // unsupported < dead < unsafe.
    assert.deepEqual(entry.sample_stale_candidate_ids, [
      "k10",
      "k7",
      "k9",
      "k11",
      "k8",
    ]);
  });
});
