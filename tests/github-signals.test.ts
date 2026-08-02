// Tests for the shared github-signals capture core (src/github-signals-core.ts,
// extracted from scripts/github-signals.ts so the CLI seed script and the
// Worker cron share one implementation) plus the script-side subnet projection
// that stays in scripts/github-signals.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  captureGithubSignals,
  fetchCommitActivity,
  fetchReleases,
  fetchRepoSignals,
  githubRepoMapKey,
  githubSignalsContentDigest,
  parseGithubRepoUrl,
  signalsByKey,
  type GithubSignalsArtifact,
  type RepoSignal,
} from "../src/github-signals-core.ts";
import { githubSignalsForSubnet } from "../scripts/github-signals.ts";

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
        releases: null,
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
        releases: null,
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
    github_releases: null,
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
      github_releases: null,
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
      github_releases: null,
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

  test("defaults a week entry's missing total to 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, [{ week: 1700000000 }])),
    );
    const result = await fetchCommitActivity("opentensor", "subtensor");
    assert.deepEqual(result, [
      { week: new Date(1700000000 * 1000).toISOString(), count: 0 },
    ]);
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

  test("returns null on a non-array 200 body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    const result = await fetchCommitActivity("opentensor", "subtensor");
    assert.equal(result, null);
  });

  test("uses the injected fetchImpl and sends the caller's headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, [{ week: 1700000000, total: 2 }]));
    const result = await fetchCommitActivity("opentensor", "subtensor", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { authorization: "Bearer x" },
    });
    assert.equal(result?.[0]?.count, 2);
    assert.equal(
      fetchImpl.mock.calls[0][0],
      "https://api.github.com/repos/opentensor/subtensor/stats/commit_activity",
    );
    assert.deepEqual(fetchImpl.mock.calls[0][1], {
      headers: { authorization: "Bearer x" },
    });
  });
});

describe("fetchReleases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const release = (overrides: Record<string, unknown> = {}) => ({
    tag_name: "v1.0.0",
    name: "Release 1.0.0",
    published_at: "2026-07-01T00:00:00Z",
    html_url: "https://github.com/opentensor/subtensor/releases/tag/v1.0.0",
    draft: false,
    prerelease: false,
    ...overrides,
  });

  test("captures published releases, keeping and flagging prereleases", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, [
            release(),
            release({ tag_name: "v1.1.0-rc1", prerelease: true }),
          ]),
        ),
    );
    const result = await fetchReleases("opentensor", "subtensor");
    assert.equal(result?.length, 2);
    assert.deepEqual(result?.[0], {
      tag: "v1.0.0",
      name: "Release 1.0.0",
      published_at: "2026-07-01T00:00:00Z",
      url: "https://github.com/opentensor/subtensor/releases/tag/v1.0.0",
      prerelease: false,
    });
    assert.equal(result?.[1]?.prerelease, true);
  });

  test("excludes drafts and entries missing a tag, date, or URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, [
            release({ draft: true }),
            release({ tag_name: "   " }),
            release({ tag_name: 42 }),
            release({ published_at: null }),
            release({ html_url: undefined }),
            null,
            "not-an-object",
            release({ tag_name: "v2.0.0" }),
          ]),
        ),
    );
    const result = await fetchReleases("opentensor", "subtensor");
    assert.deepEqual(
      result?.map((r) => r.tag),
      ["v2.0.0"],
    );
  });

  test("normalizes an absent or empty name to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, [release({ name: "" }), release({ name: 7 })]),
        ),
    );
    const result = await fetchReleases("opentensor", "subtensor");
    assert.deepEqual(
      result?.map((r) => r.name),
      [null, null],
    );
  });

  test("returns [] when the repo publishes no releases (distinct from failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [])));
    assert.deepEqual(await fetchReleases("opentensor", "subtensor"), []);
  });

  test("returns null when GitHub could not be asked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));
    assert.equal(await fetchReleases("opentensor", "subtensor"), null);
  });

  test("returns null on a non-array 200 body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    assert.equal(await fetchReleases("opentensor", "subtensor"), null);
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
    releases: null,
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

  test("stamps the caller-supplied capturedAt on a successful capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => jsonResponse(200, {})),
    );
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      undefined,
      { capturedAt: "2026-08-01T06:20:00.000Z" },
    );
    assert.equal(result?.captured_at, "2026-08-01T06:20:00.000Z");
    // Missing metadata fields degrade to null, not garbage.
    assert.equal(result?.last_push_at, null);
    assert.equal(result?.stars, null);
  });

  test("a failed /languages call degrades that one field to null on an otherwise-good capture", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/languages")) return jsonResponse(500, {});
      if (String(url).includes("/stats/commit_activity"))
        return jsonResponse(200, []);
      if (String(url).includes("/releases")) return jsonResponse(200, []);
      return jsonResponse(200, { stargazers_count: 3 });
    });
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    assert.equal(result?.languages, null);
    assert.equal(result?.stars, 3);
    assert.equal(result?.unreachable, false);
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

  test("drops the repo when the previous entry has no captured_at to measure retention from", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const undated: RepoSignal = { ...previousEntry, captured_at: null };
    const result = await fetchRepoSignals(
      { owner: "opentensor", repo: "subtensor" },
      undated,
    );
    assert.equal(result, null);
  });
});

describe("signalsByKey", () => {
  test("keys entries by lowercased owner/repo", () => {
    const map = signalsByKey({
      signals: [
        { owner: "OpenTensor", repo: "Subtensor", stars: 1 },
        { owner: "macrocosm-os", repo: "prompting", stars: 2 },
      ],
    });
    assert.equal(map.size, 2);
    assert.equal(map.get("opentensor/subtensor")?.stars, 1);
  });

  test("drops entries missing owner or repo", () => {
    const map = signalsByKey({
      signals: [{ owner: "opentensor" }, { repo: "subtensor" }, null],
    });
    assert.equal(map.size, 0);
  });

  test("tolerates a null/malformed document", () => {
    assert.equal(signalsByKey(null).size, 0);
    assert.equal(signalsByKey({ signals: "nope" }).size, 0);
    assert.equal(signalsByKey("garbage").size, 0);
  });
});

describe("captureGithubSignals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // URL-dispatching fetch double: metadata calls succeed for `good/*` repos and
  // fail for `bad/*` ones, so retention and drop paths run through the real
  // whole-artifact entry point.
  function stubCapture() {
    return vi.fn().mockImplementation((url: string) => {
      const key = String(url);
      if (key.includes("/repos/bad/")) return jsonResponse(500, {});
      if (key.includes("/languages")) return jsonResponse(200, { Rust: 10 });
      if (key.includes("/stats/commit_activity"))
        return jsonResponse(200, [{ week: 1700000000, total: 1 }]);
      if (key.includes("/releases")) return jsonResponse(200, []);
      return jsonResponse(200, { pushed_at: "2026-07-20T00:00:00Z" });
    });
  }

  test("captures the repo list into a sorted artifact with counts", async () => {
    const fetchImpl = stubCapture();
    const artifact = await captureGithubSignals(
      [
        { owner: "zeta", repo: "b" },
        { owner: "zeta", repo: "a" },
        { owner: "alpha", repo: "z" },
      ],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        capturedAt: "2026-08-01T06:20:00.000Z",
      },
    );
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.generated_at, "2026-08-01T06:20:00.000Z");
    assert.equal(artifact.repo_count, 3);
    assert.equal(artifact.captured_count, 3);
    assert.deepEqual(
      artifact.signals.map((s) => `${s.owner}/${s.repo}`),
      ["alpha/z", "zeta/a", "zeta/b"],
    );
    assert.equal(artifact.signals[0].captured_at, "2026-08-01T06:20:00.000Z");
    assert.deepEqual(artifact.signals[0].languages, { Rust: 10 });
  });

  test("retains a failing repo's <30d last-good entry and drops one with no history", async () => {
    const fetchImpl = stubCapture();
    const previous: RepoSignal = {
      owner: "bad",
      repo: "retained",
      last_push_at: "2026-06-01T00:00:00Z",
      languages: null,
      stars: 5,
      commits_weekly: null,
      releases: [],
      unreachable: false,
      captured_at: new Date().toISOString(),
    };
    const artifact = await captureGithubSignals(
      [
        { owner: "bad", repo: "retained" },
        { owner: "bad", repo: "dropped" },
        { owner: "good", repo: "fresh" },
      ],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        previousByKey: new Map([["bad/retained", previous]]),
        capturedAt: "2026-08-01T06:20:00.000Z",
      },
    );
    assert.equal(artifact.repo_count, 3);
    assert.equal(artifact.captured_count, 2);
    const retained = artifact.signals.find((s) => s.repo === "retained");
    assert.equal(retained?.unreachable, true);
    assert.equal(retained?.stars, 5);
    assert.equal(
      artifact.signals.some((s) => s.repo === "dropped"),
      false,
    );
  });

  test("defaults: empty repo list, no previous map, wall-clock timestamps, global fetch", async () => {
    vi.stubGlobal("fetch", stubCapture());
    const before = Date.now();
    const artifact = await captureGithubSignals([]);
    assert.deepEqual(artifact.signals, []);
    assert.equal(artifact.repo_count, 0);
    assert.equal(artifact.captured_count, 0);
    assert.ok(Date.parse(artifact.generated_at) >= before);
  });

  test("generatedAt can differ from capturedAt when a caller needs it to", async () => {
    const fetchImpl = stubCapture();
    const artifact = await captureGithubSignals(
      [{ owner: "good", repo: "x" }],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        capturedAt: "2026-08-01T06:20:00.000Z",
        generatedAt: "2026-08-01T06:25:00.000Z",
      },
    );
    assert.equal(artifact.generated_at, "2026-08-01T06:25:00.000Z");
    assert.equal(artifact.signals[0].captured_at, "2026-08-01T06:20:00.000Z");
  });
});

describe("githubSignalsContentDigest", () => {
  const artifact = (overrides: Record<string, unknown> = {}) =>
    ({
      schema_version: 1,
      generated_at: "2026-08-01T06:20:00.000Z",
      repo_count: 1,
      captured_count: 1,
      signals: [
        {
          owner: "opentensor",
          repo: "subtensor",
          last_push_at: "2026-07-20T00:00:00Z",
          languages: { Rust: 10 },
          stars: 250,
          commits_weekly: [{ week: "2026-06-28T00:00:00.000Z", count: 12 }],
          releases: [],
          unreachable: false,
          captured_at: "2026-08-01T06:20:00.000Z",
        },
      ],
      ...overrides,
    }) as unknown as GithubSignalsArtifact;

  test("ignores generated_at and per-entry captured_at (the volatile timestamps)", () => {
    const a = artifact();
    const b = artifact({ generated_at: "2026-08-02T06:20:00.000Z" });
    (b.signals[0] as { captured_at: string | null }).captured_at =
      "2026-08-02T06:20:00.000Z";
    assert.equal(githubSignalsContentDigest(a), githubSignalsContentDigest(b));
  });

  test("changes when the data actually moves", () => {
    const a = artifact();
    const b = artifact();
    (b.signals[0] as { stars: number | null }).stars = 251;
    assert.notEqual(
      githubSignalsContentDigest(a),
      githubSignalsContentDigest(b),
    );
  });

  test("is insensitive to property order", () => {
    const a = artifact();
    const reordered = JSON.parse(
      JSON.stringify(artifact()),
    ) as GithubSignalsArtifact;
    // Rebuild the entry with keys in a different insertion order.
    const entry = reordered.signals[0] as unknown as Record<string, unknown>;
    reordered.signals[0] = Object.fromEntries(
      Object.keys(entry)
        .reverse()
        .map((k) => [k, entry[k]]),
    ) as unknown as (typeof reordered.signals)[number];
    assert.equal(
      githubSignalsContentDigest(a),
      githubSignalsContentDigest(reordered),
    );
  });
});
