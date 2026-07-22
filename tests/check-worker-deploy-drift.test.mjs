import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluateDeployDrift,
  extractDeployedCommitSha,
  findPreviousScheduledRunAt,
  selectLatestProductionRelease,
} from "../scripts/check-worker-deploy-drift.ts";

describe("extractDeployedCommitSha", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);

  test("reads the git commit SHA from the workers/message annotation off the active (first) deployment", () => {
    // #7224: workers/message (set by deploy-worker-with-sourcemaps.sh's
    // --message "$(git rev-parse HEAD)"), not workers/commit_hash -- that key
    // was never a real Cloudflare Workers deployment annotation.
    const sha = extractDeployedCommitSha({
      result: {
        deployments: [
          { id: "dep-2", annotations: { "workers/message": shaA } },
          { id: "dep-1", annotations: { "workers/message": shaB } },
        ],
      },
    });
    assert.equal(sha, shaA);
  });

  test("throws when there are no deployments", () => {
    assert.throws(
      () => extractDeployedCommitSha({ result: { deployments: [] } }),
      /no deployments/,
    );
  });

  test("throws when the active deployment has no workers/message annotation", () => {
    assert.throws(
      () =>
        extractDeployedCommitSha({
          result: { deployments: [{ id: "dep-1", annotations: {} }] },
        }),
      /no workers\/message annotation containing a git commit SHA/,
    );
  });

  test("throws when workers/message isn't SHA-shaped (e.g. a deployment predating the --message fix)", () => {
    assert.throws(
      () =>
        extractDeployedCommitSha({
          result: {
            deployments: [
              {
                id: "dep-1",
                annotations: { "workers/message": "not-a-commit-sha" },
              },
            ],
          },
        }),
      /no workers\/message annotation containing a git commit SHA/,
    );
  });
});

describe("selectLatestProductionRelease", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);

  test("picks the most recently created bare-SHA release", () => {
    const release = selectLatestProductionRelease([
      { version: shaA, dateCreated: "2026-07-19T00:00:00Z" },
      { version: shaB, dateCreated: "2026-07-20T00:00:00Z" },
    ]);
    assert.equal(release.version, shaB);
  });

  test("excludes PR-preview releases even if more recent", () => {
    // apps/ui's ui-preview-deploy.yml tags preview deploys "<sha>-preview" --
    // a preview build must never be mistaken for what's live in production.
    const release = selectLatestProductionRelease([
      { version: shaA, dateCreated: "2026-07-19T00:00:00Z" },
      { version: `${shaB}-preview`, dateCreated: "2026-07-20T00:00:00Z" },
    ]);
    assert.equal(release.version, shaA);
  });

  test("excludes non-SHA-shaped versions (e.g. a Cloudflare version UUID)", () => {
    const release = selectLatestProductionRelease([
      {
        version: "c40c4e0e-5143-4207-ac02-7b94edebb4d2",
        dateCreated: "2026-07-20T00:00:00Z",
      },
      { version: shaA, dateCreated: "2026-07-19T00:00:00Z" },
    ]);
    assert.equal(release.version, shaA);
  });

  test("returns null when no release is a bare production SHA", () => {
    assert.equal(
      selectLatestProductionRelease([
        { version: `${shaA}-preview`, dateCreated: "2026-07-20T00:00:00Z" },
      ]),
      null,
    );
  });

  test("tolerates a non-array input", () => {
    assert.equal(selectLatestProductionRelease(undefined), null);
    assert.equal(selectLatestProductionRelease(null), null);
  });
});

describe("findPreviousScheduledRunAt", () => {
  test("returns the most recent completed run excluding the current run", () => {
    const at = findPreviousScheduledRunAt(
      {
        workflow_runs: [
          { id: 3, created_at: "2026-07-14T09:00:00Z" },
          { id: 2, created_at: "2026-07-13T09:00:00Z" },
          { id: 1, created_at: "2026-07-12T09:00:00Z" },
        ],
      },
      3,
    );
    assert.equal(at, "2026-07-13T09:00:00Z");
  });

  test("returns null when there is no prior run", () => {
    const at = findPreviousScheduledRunAt(
      { workflow_runs: [{ id: 1, created_at: "2026-07-14T09:00:00Z" }] },
      1,
    );
    assert.equal(at, null);
  });

  test("tolerates a missing workflow_runs array", () => {
    assert.equal(findPreviousScheduledRunAt({}, 1), null);
  });
});

describe("evaluateDeployDrift", () => {
  test("no alert when the deployed commit matches origin/main HEAD", () => {
    const r = evaluateDeployDrift({
      deployedCommitSha: "abc123",
      mainHeadSha: "abc123",
      mainHeadCommittedAt: "2026-07-14T09:00:00Z",
      previousScheduledRunAt: "2026-07-13T09:00:00Z",
    });
    assert.equal(r.drifted, false);
    assert.equal(r.shouldAlert, false);
  });

  test("no alert on the very first scheduled run ever (no prior run to compare)", () => {
    const r = evaluateDeployDrift({
      deployedCommitSha: "old999",
      mainHeadSha: "abc123",
      mainHeadCommittedAt: "2026-07-14T09:00:00Z",
      previousScheduledRunAt: null,
    });
    assert.equal(r.drifted, true);
    assert.equal(r.shouldAlert, false);
    assert.match(r.reason, /no prior scheduled run/);
  });

  test("no alert when main HEAD was pushed after the previous scheduled run (first run to see it)", () => {
    const r = evaluateDeployDrift({
      deployedCommitSha: "old999",
      mainHeadSha: "abc123",
      mainHeadCommittedAt: "2026-07-14T10:00:00Z",
      previousScheduledRunAt: "2026-07-14T09:00:00Z",
    });
    assert.equal(r.drifted, true);
    assert.equal(r.shouldAlert, false);
    assert.match(r.reason, /first scheduled run to observe/);
  });

  test("alerts once the drift already existed as of the previous scheduled run", () => {
    const r = evaluateDeployDrift({
      deployedCommitSha: "old999",
      mainHeadSha: "abc123",
      mainHeadCommittedAt: "2026-07-12T09:00:00Z",
      previousScheduledRunAt: "2026-07-13T09:00:00Z",
    });
    assert.equal(r.drifted, true);
    assert.equal(r.shouldAlert, true);
    assert.match(r.reason, /persisted across more than one scheduled run/);
  });
});
