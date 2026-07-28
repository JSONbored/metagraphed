import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  fetchCommitActivity,
  fetchRepoSignals,
  githubRepoMapKey,
  githubSignalsForSubnet,
  parseGithubRepoUrl,
  type RepoSignal,
} from "../scripts/github-signals.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("parseGithubRepoUrl", () => {
  test("parses a well-formed github.com repo URL", () => {
    assert.deepEqual(
      parseGithubRepoUrl("https://github.com/opentensor/subtensor"),
      {
        owner: "opentensor",
        repo: "subtensor",
      },
    );
  });

  test("strips a trailing .git suffix", () => {
    assert.deepEqual(
      parseGithubRepoUrl("https://github.com/opentensor/subtensor.git"),
      {
        owner: "opentensor",
        repo: "subtensor",
      },
    );
  });

  test("tolerates a trailing path (e.g. a subdirectory or blob link)", () => {
    assert.deepEqual(
      parseGithubRepoUrl(
        "https://github.com/opentensor/subtensor/tree/main/docs",
      ),
      { owner: "opentensor", repo: "subtensor" },
    );
  });

  test("returns null for a non-GitHub host", () => {
    assert.equal(
      parseGithubRepoUrl("https://gitlab.com/opentensor/subtensor"),
      null,
    );
  });

  test("returns null for a github.com URL missing owner or repo", () => {
    assert.equal(parseGithubRepoUrl("https://github.com/opentensor"), null);
    assert.equal(parseGithubRepoUrl("https://github.com/"), null);
  });

  test("returns null for nullish/malformed/non-string input", () => {
    for (const value of [null, undefined, "", "not a url", 42]) {
      assert.equal(parseGithubRepoUrl(value), null);
    }
  });
});

describe("githubRepoMapKey", () => {
  test("lowercases both segments so casing differences still match", () => {
    assert.equal(
      githubRepoMapKey("OpenTensor", "Subtensor"),
      "opentensor/subtensor",
    );
    assert.equal(
      githubRepoMapKey("opentensor", "subtensor"),
      githubRepoMapKey("OpenTensor", "Subtensor"),
    );
  });
});

describe("githubSignalsForSubnet", () => {
  const signalsByRepo = new Map([
    [
      "opentensor/subtensor",
      {
        languages: { Rust: 900_000, Python: 1_000 },
        last_push_at: "2026-07-01T00:00:00Z",
        stars: 250,
        commits_weekly: [{ week: "2026-06-28T00:00:00.000Z", count: 12 }],
        unreachable: false,
        captured_at: "2026-07-15T00:00:00Z",
      },
    ],
    [
      "opentensor/stale-repo",
      {
        languages: null,
        last_push_at: "2026-05-01T00:00:00Z",
        stars: 10,
        commits_weekly: null,
        unreachable: true,
        captured_at: "2026-06-01T00:00:00Z",
      },
    ],
  ]);

  const emptyShape = {
    github_languages: null,
    github_last_push_at: null,
    github_stars: null,
    github_commits_weekly: null,
    github_unreachable: false,
  };

  test("resolves the curated overlay source_repo when present", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://github.com/opentensor/subtensor" },
      {
        chain_identity: { github_repo: "https://github.com/someone-else/junk" },
      },
    );
    assert.deepEqual(result, {
      github_languages: { Rust: 900_000, Python: 1_000 },
      github_last_push_at: "2026-07-01T00:00:00Z",
      github_stars: 250,
      github_commits_weekly: [{ week: "2026-06-28T00:00:00.000Z", count: 12 }],
      github_unreachable: false,
    });
  });

  test("falls back to the on-chain chain_identity.github_repo when no overlay is set", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: undefined },
      {
        chain_identity: {
          github_repo: "https://github.com/opentensor/subtensor",
        },
      },
    );
    assert.deepEqual(result.github_last_push_at, "2026-07-01T00:00:00Z");
  });

  test("surfaces a retained-but-unreachable entry's last-good data with the flag set", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://github.com/opentensor/stale-repo" },
      {},
    );
    assert.deepEqual(result, {
      github_languages: null,
      github_last_push_at: "2026-05-01T00:00:00Z",
      github_stars: 10,
      github_commits_weekly: null,
      github_unreachable: true,
    });
  });

  test("returns the empty shape when source_repo isn't a GitHub URL", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://gitlab.com/opentensor/subtensor" },
      {},
    );
    assert.deepEqual(result, emptyShape);
  });

  test("returns the empty shape when the repo resolves but has no captured signals yet", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://github.com/some/uncaptured-repo" },
      {},
    );
    assert.deepEqual(result, emptyShape);
  });

  test("returns the empty shape when there's no source_repo at all", () => {
    const result = githubSignalsForSubnet(signalsByRepo, {}, {});
    assert.deepEqual(result, emptyShape);
  });
});

describe("fetchCommitActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("slices the last COMMIT_WEEKS_SHOWN weeks from the 52-week response", async () => {
    const weeks = Array.from({ length: 52 }, (_, i) => ({
      week: 1700000000 + i * 604800,
      total: i,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, weeks)));
    const result = await fetchCommitActivity("opentensor", "subtensor");
    assert.equal(result?.length, 13);
    assert.equal(result?.at(-1)?.count, 51);
  });

  test("returns null when GitHub is still computing stats (202, empty body)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(202, [])));
    const result = await fetchCommitActivity("opentensor", "subtensor");
    assert.equal(result, null);
  });

  test("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
    const result = await fetchCommitActivity("opentensor", "subtensor");
    assert.equal(result, null);
  });
});

describe("fetchRepoSignals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const previousEntry: RepoSignal = {
    owner: "opentensor",
    repo: "subtensor",
    last_push_at: "2026-06-01T00:00:00Z",
    languages: { Rust: 1 },
    stars: 99,
    commits_weekly: [{ week: "2026-05-25T00:00:00.000Z", count: 3 }],
    unreachable: false,
    captured_at: new Date().toISOString(),
  };

  test("returns a fresh, reachable entry on a successful metadata fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        jsonResponse(200, {
          pushed_at: "2026-07-20T00:00:00Z",
          stargazers_count: 500,
        }),
      ),
    );
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      undefined,
    );
    assert.equal(result?.unreachable, false);
    assert.equal(result?.stars, 500);
    assert.equal(result?.last_push_at, "2026-07-20T00:00:00Z");
  });

  test("retains the previous entry's data, marked unreachable, when the metadata fetch fails within the retention window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      previousEntry,
    );
    assert.equal(result?.unreachable, true);
    assert.equal(result?.stars, 99);
    assert.equal(result?.last_push_at, "2026-06-01T00:00:00Z");
  });

  test("drops the repo entirely when the metadata fetch fails and there's no previous entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      undefined,
    );
    assert.equal(result, null);
  });

  test("drops the repo when the metadata fetch fails and the previous entry is past the 30-day retention window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const stale: RepoSignal = {
      ...previousEntry,
      captured_at: "2020-01-01T00:00:00Z",
    };
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      stale,
    );
    assert.equal(result, null);
  });
});
