// Worker-side tests for the github-signals cron (#233 pattern): the daily
// scheduled branch that captures GitHub dev-signals and writes the R2 store,
// replacing the retired sync-github-signals.yml commit-a-file workflow.
//
// Same URL-dispatching fetch double convention as
// tests/upgrade-radar-cron.test.ts — an unstubbed URL throws rather than
// returning something plausible, so a handler that asks the wrong upstream
// fails here instead of passing on a canned answer (the #8687 lesson).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  GITHUB_SIGNALS_MAX_REPOS_PER_RUN,
  GITHUB_SIGNALS_R2_KEY,
  githubSignalsHeaders,
  reposForRun,
  runGithubSignalsSync,
  trackedReposFromSubnets,
} from "../src/github-signals-sync.ts";
import type {
  GithubSignalsArtifact,
  RepoSignal,
} from "../src/github-signals-core.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

const TICK_MS = Date.parse("2026-08-01T06:20:00.000Z");

function subnetsArtifact(sourceRepos: (string | null)[]): Row {
  return {
    subnets: sourceRepos.map((source_repo, netuid) => ({
      netuid,
      source_repo,
    })),
  };
}

function readArtifactStub(doc: Row | null): AnyFn {
  return vi.fn(async (_env: unknown, path: string) => {
    assert.equal(path, "/metagraph/subnets.json");
    return doc
      ? { ok: true, data: doc, source: "r2", storage_tier: "dual" }
      : { ok: false, status: 404, code: "artifact_not_found", message: "no" };
  });
}

/** In-memory R2 double: get/put over a Map, values stored as JSON strings. */
function fakeBucket(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: Array<{ key: string; value: string; options: unknown }> = [];
  return {
    store,
    puts,
    bucket: {
      get: async (key: string) => {
        const raw = store.get(key);
        if (raw == null) return null;
        return { json: async () => JSON.parse(raw) };
      },
      put: async (key: string, value: string, options: unknown) => {
        store.set(key, value);
        puts.push({ key, value, options });
      },
    },
  };
}

/**
 * GitHub fetch double: metadata succeeds for any repo not under `bad/`, with
 * per-endpoint bodies keyed off the URL shape fetchRepoSignals actually asks.
 */
function githubFetchImpl(calls?: Array<{ url: string; headers: unknown }>) {
  return vi.fn(async (url: string, init?: { headers?: unknown }) => {
    const key = String(url);
    calls?.push({ url: key, headers: init?.headers });
    const body = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status });
    if (!key.startsWith("https://api.github.com/repos/")) {
      throw new Error(`unexpected upstream: ${key}`);
    }
    if (key.includes("/repos/bad/")) return body(500, {});
    if (key.includes("/languages")) return body(200, { Python: 42 });
    if (key.includes("/stats/commit_activity"))
      return body(200, [{ week: 1700000000, total: 3 }]);
    if (key.includes("/releases")) return body(200, []);
    return body(200, {
      pushed_at: "2026-07-20T00:00:00Z",
      stargazers_count: 7,
    });
  });
}

function syncDeps(overrides: Record<string, unknown> = {}) {
  return {
    readArtifact: readArtifactStub(
      subnetsArtifact(["https://github.com/good/repo-a"]),
    ),
    fetchImpl: githubFetchImpl() as unknown as typeof fetch,
    now: () => TICK_MS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("githubSignalsHeaders", () => {
  test("authenticates and carries the GitHub API requisites", () => {
    const headers = githubSignalsHeaders("tok-123");
    assert.equal(headers.authorization, "Bearer tok-123");
    assert.equal(headers["x-github-api-version"], "2022-11-28");
    // GitHub rejects API requests with no user-agent.
    assert.ok(headers["user-agent"]);
    assert.ok(headers.accept.includes("github"));
  });
});

describe("trackedReposFromSubnets", () => {
  test("parses, dedupes (case-insensitively), and skips non-GitHub rows", () => {
    const repos = trackedReposFromSubnets([
      { netuid: 1, source_repo: "https://github.com/Team/Mono" },
      { netuid: 2, source_repo: "https://github.com/team/mono" },
      { netuid: 3, source_repo: "https://gitlab.com/other/repo" },
      { netuid: 4, source_repo: null },
      null,
      { netuid: 5, source_repo: "https://github.com/solo/repo" },
    ]);
    assert.deepEqual(repos, [
      { owner: "Team", repo: "Mono" },
      { owner: "solo", repo: "repo" },
    ]);
  });

  test("returns [] for a non-array input", () => {
    assert.deepEqual(trackedReposFromSubnets(undefined), []);
    assert.deepEqual(trackedReposFromSubnets({}), []);
  });
});

describe("reposForRun", () => {
  const manyRepos = Array.from(
    { length: GITHUB_SIGNALS_MAX_REPOS_PER_RUN + 20 },
    (_, i) => ({ owner: "owner", repo: `repo-${i}` }),
  );

  test("runs the whole list daily while under the subrequest ceiling", () => {
    const repos = manyRepos.slice(0, 100);
    assert.deepEqual(reposForRun(repos, 1), repos);
    assert.deepEqual(reposForRun(repos, 2), repos);
  });

  test("over the ceiling, splits deterministically by day parity and covers every repo across two days", () => {
    const day1 = reposForRun(manyRepos, 1);
    const day2 = reposForRun(manyRepos, 2);
    // Deterministic: the same day always yields the same half.
    assert.deepEqual(reposForRun(manyRepos, 3), day1);
    // Disjoint halves that jointly cover the full set.
    const union = new Set(
      [...day1, ...day2].map((r) => `${r.owner}/${r.repo}`),
    );
    assert.equal(union.size, manyRepos.length);
    assert.ok(day1.length <= GITHUB_SIGNALS_MAX_REPOS_PER_RUN);
    assert.ok(day2.length <= GITHUB_SIGNALS_MAX_REPOS_PER_RUN);
  });

  test("hard-caps a pathological half at the ceiling", () => {
    // Repos crafted irrelevant: even if one parity bucket exceeded the cap,
    // slice() bounds it. Force the situation with a big same-parity list by
    // checking the invariant on the real split output instead.
    const huge = Array.from({ length: 1000 }, (_, i) => ({
      owner: "o",
      repo: `r${i}`,
    }));
    assert.ok(reposForRun(huge, 5).length <= GITHUB_SIGNALS_MAX_REPOS_PER_RUN);
  });
});

describe("runGithubSignalsSync", () => {
  test("no token: no-ops LOUDLY — console.error + one exception event — and never fetches", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const telemetryCalls: string[] = [];
    // recordExceptionEvent posts via the global fetch; capture it to prove
    // the loud half of the no-op actually fires.
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
      telemetryCalls.push(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    const { bucket } = fakeBucket();
    const deps = syncDeps();
    const waited: Promise<unknown>[] = [];
    const result = await runGithubSignalsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket, POSTHOG_PROJECT_TOKEN: "phc_t" }),
      { waitUntil: (p) => waited.push(p) },
      deps,
    );
    await Promise.all(waited);
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "GITHUB_SIGNALS_TOKEN not configured",
    });
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.ok(
      String(errorSpy.mock.calls[0][0]).includes("GITHUB_SIGNALS_TOKEN"),
    );
    assert.equal(telemetryCalls.length, 1);
    assert.ok(telemetryCalls[0].includes("$exception"));
    assert.ok(telemetryCalls[0].includes("cron:github-signals-sync"));
    // The capture itself never ran.
    assert.equal(
      (deps.readArtifact as AnyFn & { mock: Row }).mock.calls.length,
      0,
    );
  });

  test("a rejecting telemetry hop can never surface out of the no-op path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    const result = await runGithubSignalsSync(
      mockEnv({}),
      { waitUntil: (p) => waited.push(p) },
      syncDeps({
        recordException: async () => {
          throw new Error("telemetry exploded");
        },
      }),
    );
    assert.equal(result.skipped, true);
    // The floated promise settles to the swallowed-false path, not a rejection.
    assert.deepEqual(await Promise.all(waited), [false]);
  });

  test("a whitespace-only or non-string token is treated as unset, and no ctx is required", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const token of ["   ", 42 as unknown as string]) {
      const result = await runGithubSignalsSync(
        mockEnv({ GITHUB_SIGNALS_TOKEN: token }),
        undefined,
        syncDeps(),
      );
      assert.equal(result.skipped, true);
    }
    assert.equal(errorSpy.mock.calls.length, 2);
  });

  test("refuses to run without an injected artifact reader", async () => {
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok" }),
      undefined,
      syncDeps({ readArtifact: undefined }),
    );
    assert.deepEqual(result, { ok: false, reason: "reader_unavailable" });
  });

  test("refuses to run without a complete R2 binding", async () => {
    for (const archive of [undefined, {}, { get: async () => null }]) {
      const result = await runGithubSignalsSync(
        mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: archive }),
        undefined,
        syncDeps(),
      );
      assert.deepEqual(result, { ok: false, reason: "r2_binding_missing" });
    }
  });

  test("an unreadable subnets artifact is a no-op, never a wipe", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({ readArtifact: readArtifactStub(null) }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "subnets_artifact_unavailable",
    });
    assert.equal(puts.length, 0);
  });

  test("an artifact with zero resolvable source repos is rejected as broken input", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(subnetsArtifact([null, null])),
      }),
    );
    assert.deepEqual(result, { ok: false, reason: "no_tracked_repos" });
    assert.equal(puts.length, 0);
  });

  test("first run: captures the deduped repo list and writes the store with real timestamps", async () => {
    const { bucket, puts, store } = fakeBucket();
    const calls: Array<{ url: string; headers: unknown }> = [];
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(
          subnetsArtifact([
            "https://github.com/good/repo-a",
            "https://github.com/good/repo-a", // shared monorepo — deduped
            "https://github.com/good/repo-b",
            "https://gitlab.com/not/github",
          ]),
        ),
        fetchImpl: githubFetchImpl(calls) as unknown as typeof fetch,
      }),
    );
    assert.deepEqual(result, {
      ok: true,
      changed: true,
      repo_count: 2,
      captured_count: 2,
    });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, GITHUB_SIGNALS_R2_KEY);
    assert.deepEqual(puts[0].options, {
      httpMetadata: { contentType: "application/json" },
    });
    const written = JSON.parse(
      store.get(GITHUB_SIGNALS_R2_KEY) as string,
    ) as GithubSignalsArtifact;
    assert.equal(written.schema_version, 1);
    // Real tick time, not the 1970 build placeholder — the retention window
    // must measure actual age in this lane.
    assert.equal(written.generated_at, "2026-08-01T06:20:00.000Z");
    assert.equal(written.signals[0].captured_at, "2026-08-01T06:20:00.000Z");
    assert.deepEqual(
      written.signals.map((s) => `${s.owner}/${s.repo}`),
      ["good/repo-a", "good/repo-b"],
    );
    // 2 repos x 4 GitHub calls, every one authenticated.
    assert.equal(calls.length, 8);
    for (const call of calls) {
      assert.equal(
        (call.headers as Record<string, string>).authorization,
        "Bearer tok",
      );
    }
  });

  test("unchanged content skips the write (timestamps alone never churn the store)", async () => {
    const { bucket: coldBucket, store } = fakeBucket();
    const deps = syncDeps();
    const env = mockEnv({
      GITHUB_SIGNALS_TOKEN: "tok",
      METAGRAPH_ARCHIVE: coldBucket,
    });
    const first = await runGithubSignalsSync(env, undefined, deps);
    assert.equal(first.changed, true);

    // Re-run against the now-populated store, one day later: identical data.
    const { bucket, puts } = fakeBucket({
      [GITHUB_SIGNALS_R2_KEY]: JSON.parse(
        store.get(GITHUB_SIGNALS_R2_KEY) as string,
      ),
    });
    const second = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({ now: () => TICK_MS + 24 * 60 * 60 * 1000 }),
    );
    assert.deepEqual(second, {
      ok: true,
      changed: false,
      repo_count: 1,
      captured_count: 1,
    });
    assert.equal(puts.length, 0);
  });

  test("retains a failing repo's <30d last-good store entry, marked unreachable", async () => {
    const previous: RepoSignal = {
      owner: "bad",
      repo: "flaky",
      last_push_at: "2026-07-10T00:00:00Z",
      languages: { Rust: 1 },
      stars: 11,
      commits_weekly: null,
      releases: [],
      unreachable: false,
      captured_at: new Date(TICK_MS - 24 * 60 * 60 * 1000).toISOString(),
    };
    const { bucket, store } = fakeBucket({
      [GITHUB_SIGNALS_R2_KEY]: {
        schema_version: 1,
        generated_at: previous.captured_at,
        repo_count: 1,
        captured_count: 1,
        signals: [previous],
      },
    });
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(
          subnetsArtifact([
            "https://github.com/bad/flaky",
            "https://github.com/good/solid",
          ]),
        ),
      }),
    );
    assert.deepEqual(result, {
      ok: true,
      changed: true,
      repo_count: 2,
      captured_count: 2,
    });
    const written = JSON.parse(
      store.get(GITHUB_SIGNALS_R2_KEY) as string,
    ) as GithubSignalsArtifact;
    const flaky = written.signals.find((s) => s.repo === "flaky");
    assert.equal(flaky?.unreachable, true);
    assert.equal(flaky?.stars, 11);
  });

  test("a total capture failure with retention exhausted keeps the last-good store", async () => {
    const { bucket, puts } = fakeBucket({
      [GITHUB_SIGNALS_R2_KEY]: {
        schema_version: 1,
        generated_at: "2026-01-01T00:00:00.000Z",
        repo_count: 1,
        captured_count: 1,
        signals: [
          {
            owner: "bad",
            repo: "gone",
            last_push_at: null,
            languages: null,
            stars: 1,
            commits_weekly: null,
            releases: null,
            unreachable: false,
            // Far past the 30-day retention window at TICK_MS.
            captured_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(
          subnetsArtifact(["https://github.com/bad/gone"]),
        ),
      }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "empty_capture",
      repo_count: 1,
      captured_count: 0,
    });
    assert.equal(puts.length, 0);
  });

  test("a cold or unreadable previous store degrades to a first run, not a failure", async () => {
    const { puts, bucket } = fakeBucket();
    const throwingBucket = {
      get: async () => {
        throw new Error("r2 exploded");
      },
      put: bucket.put,
    };
    const result = await runGithubSignalsSync(
      mockEnv({
        GITHUB_SIGNALS_TOKEN: "tok",
        METAGRAPH_ARCHIVE: throwingBucket,
      }),
      undefined,
      syncDeps(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(puts.length, 1);
  });

  test("an unforeseen throw is contained as one failed tick, not an exception storm", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bucket } = fakeBucket();
    const result = await runGithubSignalsSync(
      mockEnv({ GITHUB_SIGNALS_TOKEN: "tok", METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      }),
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
    assert.equal(errorSpy.mock.calls.length, 1);
  });

  test("the daily cron dispatches to it end-to-end through the Worker entry point", async () => {
    // Registering the trigger in wrangler.jsonc without wiring the branch
    // would fire a cron into a silent no-op forever.
    const { default: worker } = await import("../workers/api.ts");
    const { GITHUB_SIGNALS_SYNC_CRON } = await import("../workers/config.ts");
    const { store, bucket } = fakeBucket({
      // The real readArtifact resolves /metagraph/subnets.json through the
      // literal latest/ prefix when no publish pointer exists.
      "latest/subnets.json": subnetsArtifact([
        "https://github.com/good/repo-a",
      ]),
    });
    vi.stubGlobal("fetch", githubFetchImpl());
    const waited: Promise<unknown>[] = [];
    const result = (await worker.scheduled(
      { cron: GITHUB_SIGNALS_SYNC_CRON, scheduledTime: Date.now() } as never,
      mockEnv({
        GITHUB_SIGNALS_TOKEN: "tok",
        METAGRAPH_ARCHIVE: bucket,
      }) as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    )) as { ok: boolean; changed: boolean };
    await Promise.all(waited);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    // Proof the branch ran: only this cron writes the signals store key.
    assert.ok(store.has(GITHUB_SIGNALS_R2_KEY));
  });

  test("the registered cron matches the wrangler trigger", async () => {
    // A constant that drifts from wrangler.jsonc means the branch is dead in
    // production while every test here still passes.
    const { GITHUB_SIGNALS_SYNC_CRON } = await import("../workers/config.ts");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${GITHUB_SIGNALS_SYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${GITHUB_SIGNALS_SYNC_CRON}`,
    );
  });
});
