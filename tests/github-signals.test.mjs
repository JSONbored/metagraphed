import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  githubRepoMapKey,
  githubSignalsForSubnet,
  parseGithubRepoUrl,
} from "../scripts/github-signals.mjs";

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
      },
    ],
  ]);

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
    assert.deepEqual(result, {
      github_languages: { Rust: 900_000, Python: 1_000 },
      github_last_push_at: "2026-07-01T00:00:00Z",
    });
  });

  test("returns the null/null shape when source_repo isn't a GitHub URL", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://gitlab.com/opentensor/subtensor" },
      {},
    );
    assert.deepEqual(result, {
      github_languages: null,
      github_last_push_at: null,
    });
  });

  test("returns the null/null shape when the repo resolves but has no captured signals yet", () => {
    const result = githubSignalsForSubnet(
      signalsByRepo,
      { source_repo: "https://github.com/some/uncaptured-repo" },
      {},
    );
    assert.deepEqual(result, {
      github_languages: null,
      github_last_push_at: null,
    });
  });

  test("returns the null/null shape when there's no source_repo at all", () => {
    const result = githubSignalsForSubnet(signalsByRepo, {}, {});
    assert.deepEqual(result, {
      github_languages: null,
      github_last_push_at: null,
    });
  });
});
