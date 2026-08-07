// Tests for the daily link-rot lane (#9907/#9914/#9917) and the SSRF-guard
// split it depends on (#9870).
//
// Same URL-dispatching fetch double convention as
// tests/github-signals-sync.test.ts — an unstubbed URL throws rather than
// returning something plausible, so a checker that asks the wrong upstream
// fails here instead of passing on a canned answer.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  checkLink,
  checkLinks,
  collectLinkTargets,
  githubApiUrl,
  isConfirmedDeadLink,
  isSelfHostedUrl,
  linkCheckStrategy,
  linkHostKey,
  nextLinkRecord,
  LINK_DEAD_STRIKES,
  LINK_STATUS_R2_KEY,
  UNREACHABLE_CLASSIFICATIONS,
  type LinkStatusRecord,
} from "../src/link-status-core.ts";
import {
  runLinkStatusSync,
  urlsForRun,
  LINK_STATUS_PROVIDERS_ARTIFACT_PATH,
  LINK_STATUS_SUBNETS_ARTIFACT_PATH,
} from "../src/link-status-sync.ts";
import { surfaceEvidenceIsDead } from "../src/surface-verification.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

const TICK_MS = Date.parse("2026-08-08T07:35:00.000Z");
const TICK_ISO = new Date(TICK_MS).toISOString();
const OP_KINDS = new Set(OPERATIONAL_SURFACE_KINDS);

function record(overrides: Partial<LinkStatusRecord> = {}): LinkStatusRecord {
  return {
    url: "https://example.com/a",
    classification: "live",
    status_code: 200,
    checked_at: "2026-08-01T00:00:00.000Z",
    last_ok: "2026-08-01T00:00:00.000Z",
    consecutive_failures: 0,
    error: null,
    ...overrides,
  };
}

// --- routing -----------------------------------------------------------------

describe("linkCheckStrategy", () => {
  test("routes our own origin away from the network entirely", () => {
    assert.equal(
      linkCheckStrategy("https://metagraph.sh/logos/oro.png"),
      "self",
    );
    assert.equal(
      linkCheckStrategy("https://www.metagraph.sh/logos/x.png"),
      "self",
    );
    assert.equal(isSelfHostedUrl("https://metagraph.sh"), true);
    assert.equal(isSelfHostedUrl("https://example.com"), false);
    assert.equal(isSelfHostedUrl("not a url"), false);
  });

  test("routes github.com owner/repo URLs to the API, other hosts to plain http", () => {
    assert.equal(
      linkCheckStrategy("https://github.com/opentensor/bittensor"),
      "github-api",
    );
    assert.equal(
      linkCheckStrategy("https://github.com/o/r/blob/main/README.md"),
      "github-api",
    );
    assert.equal(linkCheckStrategy("https://docs.bittensor.com/"), "http");
    // Too short to name a repo — an ordinary web page.
    assert.equal(linkCheckStrategy("https://github.com/features"), "http");
  });
});

describe("githubApiUrl", () => {
  test("rewrites a blob link to the contents API, carrying the ref", () => {
    assert.equal(
      githubApiUrl("https://github.com/o/r/blob/main/docs/README.md"),
      "https://api.github.com/repos/o/r/contents/docs/README.md?ref=main",
    );
  });

  test("rewrites a tree link the same way", () => {
    assert.equal(
      githubApiUrl("https://github.com/o/r/tree/dev/src"),
      "https://api.github.com/repos/o/r/contents/src?ref=dev",
    );
  });

  test("rewrites a repo root and any other sub-page to the repo endpoint", () => {
    assert.equal(
      githubApiUrl("https://github.com/o/r"),
      "https://api.github.com/repos/o/r",
    );
    assert.equal(
      githubApiUrl("https://github.com/o/r/issues"),
      "https://api.github.com/repos/o/r",
    );
  });

  test("percent-encodes path segments so a spaced filename cannot break the URL", () => {
    assert.equal(
      githubApiUrl("https://github.com/o/r/blob/main/my file.md"),
      "https://api.github.com/repos/o/r/contents/my%20file.md?ref=main",
    );
  });

  test("returns null for anything that is not a github repo URL", () => {
    assert.equal(githubApiUrl("https://example.com/x"), null);
    assert.equal(githubApiUrl("https://metagraph.sh/logos/a.png"), null);
  });
});

describe("linkHostKey", () => {
  test("groups by host, folding www, so one small host is never fanned out", () => {
    assert.equal(linkHostKey("https://a.example.com/1"), "a.example.com");
    assert.equal(linkHostKey("https://www.example.com/1"), "example.com");
    assert.equal(linkHostKey("https://example.com/2"), "example.com");
  });

  test("gives every GitHub API check its own key so they run in parallel", () => {
    const a = linkHostKey("https://github.com/o/r");
    const b = linkHostKey("https://github.com/o/other");
    assert.notEqual(a, b);
    assert.equal(a.startsWith("github-api:"), true);
  });

  test("falls back to the raw value when the URL will not parse", () => {
    assert.equal(linkHostKey("::nonsense::"), "::nonsense::");
  });
});

// --- target collection -------------------------------------------------------

describe("collectLinkTargets", () => {
  const subnets = [
    {
      netuid: 1,
      surfaces: [
        {
          id: "sn-1-api",
          kind: "subnet-api", // operational — the prober owns it
          url: "https://api.one.example/v1",
          public_safe: true,
          probe: { enabled: true },
          source_urls: ["https://github.com/one/repo/blob/main/README.md"],
        },
        {
          id: "sn-1-docs",
          kind: "docs", // NOT operational — this lane owns it
          url: "https://docs.one.example/",
          public_safe: true,
          probe: { enabled: true },
          source_urls: [],
        },
        {
          id: "sn-1-off",
          kind: "docs",
          url: "https://off.one.example/",
          public_safe: true,
          probe: { enabled: false },
        },
        {
          id: "sn-1-private",
          kind: "docs",
          url: "https://private.one.example/",
          public_safe: false,
          probe: { enabled: true },
        },
      ],
    },
  ] as Row[];
  const providers = [
    {
      slug: "acme",
      website_url: "https://acme.example",
      docs_url: "https://docs.one.example/", // same URL a surface uses
      logo_url: "not-a-url",
    },
  ] as Row[];

  test("takes source_urls from every surface, including operational ones", () => {
    const targets = collectLinkTargets(subnets, [], OP_KINDS);
    const readme = targets.find((t) => t.url.includes("README.md"));
    assert.ok(
      readme,
      "a source_url on an operational surface is still evidence",
    );
    assert.deepEqual(readme.citations, [
      { kind: "source_url", id: "sn-1-api", netuid: 1 },
    ]);
  });

  test("takes the surface URL only for kinds the prober skips", () => {
    const urls = collectLinkTargets(subnets, [], OP_KINDS).map((t) => t.url);
    assert.equal(urls.includes("https://docs.one.example/"), true);
    assert.equal(
      urls.includes("https://api.one.example/v1"),
      false,
      "an operational surface is probed every 15 minutes; checking it here too would double-count",
    );
  });

  test("skips probe-disabled and non-public surfaces", () => {
    const urls = collectLinkTargets(subnets, [], OP_KINDS).map((t) => t.url);
    assert.equal(urls.includes("https://off.one.example/"), false);
    assert.equal(urls.includes("https://private.one.example/"), false);
  });

  test("dedupes across populations and keeps every citation", () => {
    const targets = collectLinkTargets(subnets, providers, OP_KINDS);
    const shared = targets.filter((t) => t.url === "https://docs.one.example/");
    assert.equal(shared.length, 1, "one URL is one check");
    assert.deepEqual(
      shared[0].citations.map((c) => c.kind).sort(),
      ["provider", "surface"],
      "both citers are recorded so the verdict fans back out",
    );
  });

  test("ignores non-http values and returns a stable order", () => {
    const targets = collectLinkTargets(subnets, providers, OP_KINDS);
    assert.equal(
      targets.some((t) => t.url === "not-a-url"),
      false,
    );
    assert.deepEqual(
      targets.map((t) => t.url),
      [...targets.map((t) => t.url)].sort(),
    );
  });

  test("tolerates a subnet with no surfaces array", () => {
    assert.deepEqual(
      collectLinkTargets([{ netuid: 9 }] as Row[], [], OP_KINDS),
      [],
    );
  });
});

// --- the strike rule ---------------------------------------------------------

describe("nextLinkRecord / isConfirmedDeadLink", () => {
  test("a first-ever failure starts at one strike, not at dead", () => {
    const next = nextLinkRecord(
      undefined,
      { url: "u", classification: "dead", status_code: 404, error: null },
      TICK_ISO,
    );
    assert.equal(next.consecutive_failures, 1);
    assert.equal(next.last_ok, null);
    assert.equal(isConfirmedDeadLink(next), false);
  });

  test("strikes accumulate and cross the threshold at LINK_DEAD_STRIKES", () => {
    let current = record({ consecutive_failures: 0 });
    for (let i = 1; i <= LINK_DEAD_STRIKES; i += 1) {
      current = nextLinkRecord(
        current,
        { url: "u", classification: "dead", status_code: 404, error: "gone" },
        TICK_ISO,
      );
      assert.equal(current.consecutive_failures, i);
      assert.equal(isConfirmedDeadLink(current), i >= LINK_DEAD_STRIKES);
    }
  });

  test("any reachable verdict resets the streak — three failures must be IN A ROW", () => {
    const twoStrikes = record({ consecutive_failures: 2 });
    const recovered = nextLinkRecord(
      twoStrikes,
      { url: "u", classification: "live", status_code: 200, error: null },
      TICK_ISO,
    );
    assert.equal(recovered.consecutive_failures, 0);
    assert.equal(recovered.last_ok, TICK_ISO);
  });

  test("a failure preserves the previous last_ok rather than clearing it", () => {
    const prior = record({ last_ok: "2026-07-01T00:00:00.000Z" });
    const failed = nextLinkRecord(
      prior,
      { url: "u", classification: "dead", status_code: 404, error: null },
      TICK_ISO,
    );
    assert.equal(failed.last_ok, "2026-07-01T00:00:00.000Z");
  });

  test("a 403 or 429 proves the host is alive and never accrues a strike", () => {
    for (const classification of [
      "auth-required",
      "rate-limited",
      "redirected",
    ]) {
      const next = nextLinkRecord(
        record({ consecutive_failures: 2 }),
        { url: "u", classification, status_code: 403, error: null },
        TICK_ISO,
      );
      assert.equal(
        next.consecutive_failures,
        0,
        `${classification} must not count as rot — this was a real false-positive source`,
      );
    }
  });

  test("a persistent 5xx does accrue, because the streak rule makes it safe", () => {
    // api.eirel.ai serves Cloudflare 521 behind live DNS for 121 surfaces; if
    // 5xx never accrued, the lane would be blind to its single largest case.
    assert.equal(UNREACHABLE_CLASSIFICATIONS.has("transient"), true);
    assert.equal(UNREACHABLE_CLASSIFICATIONS.has("timeout"), true);
    assert.equal(UNREACHABLE_CLASSIFICATIONS.has("auth-required"), false);
    assert.equal(UNREACHABLE_CLASSIFICATIONS.has("unsafe"), false);
  });

  test("an absent record is not dead", () => {
    assert.equal(isConfirmedDeadLink(undefined), false);
  });
});

// --- what a dead link costs a surface ---------------------------------------

describe("surfaceEvidenceIsDead", () => {
  const dead = new Set(["https://a.example/gone", "https://b.example/gone"]);

  test("demotes only when EVERY source_url is dead", () => {
    assert.equal(surfaceEvidenceIsDead(["https://a.example/gone"], dead), true);
    assert.equal(
      surfaceEvidenceIsDead(
        ["https://a.example/gone", "https://alive.example/ok"],
        dead,
      ),
      false,
      "source_urls are alternative proofs of one claim, not a checklist",
    );
  });

  test("a surface with no evidence never had any to lose", () => {
    assert.equal(surfaceEvidenceIsDead([], dead), false);
    assert.equal(surfaceEvidenceIsDead(undefined, dead), false);
    assert.equal(surfaceEvidenceIsDead("https://a.example/gone", dead), false);
    assert.equal(surfaceEvidenceIsDead([""], dead), false);
    assert.equal(surfaceEvidenceIsDead([123], dead), false);
  });

  test("an empty dead-set demotes nothing, so a cold store is harmless", () => {
    assert.equal(
      surfaceEvidenceIsDead(["https://a.example/gone"], new Set()),
      false,
    );
  });
});

// --- checking ----------------------------------------------------------------

function fetchDouble(
  routes: Record<string, { status: number } | (() => Response)>,
  calls?: Array<{ url: string; method: string; headers: unknown }>,
) {
  return vi.fn(async (url: string, init?: Row) => {
    const key = String(url);
    calls?.push({
      url: key,
      method: String(init?.method || "GET"),
      headers: init?.headers,
    });
    const route = routes[key];
    if (!route) throw new Error(`unexpected upstream: ${key}`);
    if (typeof route === "function") return route();
    return new Response(null, { status: route.status });
  });
}

describe("checkLink", () => {
  test("HEADs a plain URL and reports live", async () => {
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    const result = await checkLink("https://docs.example/", {
      fetchImpl: fetchDouble(
        { "https://docs.example/": { status: 200 } },
        calls,
      ) as unknown as typeof fetch,
    });
    assert.equal(result.classification, "live");
    assert.equal(result.status_code, 200);
    assert.equal(calls[0].method, "HEAD");
  });

  test("falls back to GET when the host rejects HEAD", async () => {
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    let seen = 0;
    const result = await checkLink("https://docs.example/", {
      fetchImpl: fetchDouble(
        {
          "https://docs.example/": () =>
            new Response(null, { status: (seen += 1) === 1 ? 405 : 200 }),
        },
        calls,
      ) as unknown as typeof fetch,
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["HEAD", "GET"],
    );
    assert.equal(result.classification, "live");
  });

  test("a 404 is dead and a 403 is not", async () => {
    const gone = await checkLink("https://docs.example/x", {
      fetchImpl: fetchDouble({
        "https://docs.example/x": { status: 404 },
      }) as unknown as typeof fetch,
    });
    assert.equal(gone.classification, "dead");
    const blocked = await checkLink("https://docs.example/y", {
      fetchImpl: fetchDouble({
        "https://docs.example/y": { status: 403 },
      }) as unknown as typeof fetch,
    });
    assert.equal(blocked.classification, "auth-required");
  });

  test("asks the GitHub API — not the HTML page — and sends the token", async () => {
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    const result = await checkLink(
      "https://github.com/o/r/blob/main/README.md",
      {
        githubAuth: "Bearer t0ken",
        fetchImpl: fetchDouble(
          {
            "https://api.github.com/repos/o/r/contents/README.md?ref=main": {
              status: 200,
            },
          },
          calls,
        ) as unknown as typeof fetch,
      },
    );
    assert.equal(result.classification, "live");
    assert.equal(
      result.url,
      "https://github.com/o/r/blob/main/README.md",
      "the record is keyed by the URL the registry cites, not the API URL",
    );
    assert.equal(
      (calls[0].headers as Row).authorization,
      "Bearer t0ken",
      "unauthenticated GitHub would mass-dead every link on a shared egress IP",
    );
  });

  test("omits the header when no token is configured", async () => {
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    await checkLink("https://github.com/o/r", {
      fetchImpl: fetchDouble(
        { "https://api.github.com/repos/o/r": { status: 200 } },
        calls,
      ) as unknown as typeof fetch,
    });
    assert.equal(
      (calls[0].headers as Row | undefined)?.authorization,
      undefined,
    );
  });

  test("a refused fetch is unsupported, which does accrue a strike", async () => {
    const result = await checkLink("https://dead.example/", {
      fetchImpl: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND dead.example");
      }) as unknown as typeof fetch,
    });
    assert.equal(UNREACHABLE_CLASSIFICATIONS.has(result.classification), true);
  });
});

describe("checkLinks", () => {
  test("returns results in input order even though hosts are grouped", async () => {
    const urls = [
      "https://a.example/1",
      "https://b.example/1",
      "https://a.example/2",
    ];
    const results = await checkLinks(
      urls,
      {
        fetchImpl: fetchDouble({
          "https://a.example/1": { status: 200 },
          "https://b.example/1": { status: 404 },
          "https://a.example/2": { status: 200 },
        }) as unknown as typeof fetch,
      },
      2,
    );
    assert.deepEqual(
      results.map((r) => r.url),
      urls,
    );
    assert.deepEqual(
      results.map((r) => r.classification),
      ["live", "dead", "live"],
    );
  });
});

// --- per-run selection -------------------------------------------------------

describe("urlsForRun", () => {
  test("checks everything when the population fits", () => {
    const urls = ["a", "b", "c"];
    assert.deepEqual(urlsForRun(urls, new Map(), 10), urls);
  });

  test("prefers the least-recently-checked so the tail cannot starve", () => {
    const prior = new Map<string, LinkStatusRecord>([
      ["a", record({ url: "a", checked_at: "2026-08-07T00:00:00.000Z" })],
      ["b", record({ url: "b", checked_at: "2026-08-01T00:00:00.000Z" })],
    ]);
    // "c" has never been checked and must sort ahead of both.
    assert.deepEqual(urlsForRun(["a", "b", "c"], prior, 2), ["c", "b"]);
  });

  test("an unparseable checked_at sorts as never-checked rather than throwing", () => {
    const prior = new Map<string, LinkStatusRecord>([
      ["a", record({ url: "a", checked_at: "not a date" })],
      ["b", record({ url: "b", checked_at: "2026-08-01T00:00:00.000Z" })],
    ]);
    assert.deepEqual(urlsForRun(["a", "b"], prior, 1), ["a"]);
  });
});

// --- the cron ----------------------------------------------------------------

function fakeBucket(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: Array<{ key: string; value: string }> = [];
  return {
    store,
    puts,
    bucket: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw == null ? null : { json: async () => JSON.parse(raw) };
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
        puts.push({ key, value });
      },
    },
  };
}

function artifactStub(subnets: Row | null, providers: Row | null): AnyFn {
  return vi.fn(async (_env: unknown, path: string) => {
    const doc =
      path === LINK_STATUS_SUBNETS_ARTIFACT_PATH
        ? subnets
        : path === LINK_STATUS_PROVIDERS_ARTIFACT_PATH
          ? providers
          : null;
    return doc
      ? { ok: true, data: doc, source: "r2", storage_tier: "dual" }
      : { ok: false, status: 404, code: "artifact_not_found", message: "no" };
  });
}

const ONE_DOC_SUBNET: Row = {
  subnets: [
    {
      netuid: 1,
      surfaces: [
        {
          id: "sn-1-docs",
          kind: "docs",
          url: "https://docs.example/",
          public_safe: true,
          probe: { enabled: true },
          source_urls: [],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runLinkStatusSync", () => {
  test("refuses without a reader or an R2 binding", async () => {
    assert.deepEqual(await runLinkStatusSync(mockEnv({}), undefined, {}), {
      ok: false,
      reason: "reader_unavailable",
    });
    assert.deepEqual(
      await runLinkStatusSync(mockEnv({}), undefined, {
        readArtifact: artifactStub(ONE_DOC_SUBNET, null) as never,
      }),
      { ok: false, reason: "r2_binding_missing" },
    );
  });

  test("refuses when the subnets artifact is unreadable", async () => {
    const { bucket } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      { readArtifact: artifactStub(null, null) as never },
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "subnets_artifact_unavailable",
    });
  });

  test("a readable artifact yielding zero targets never wipes the store", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      { readArtifact: artifactStub({ subnets: [] }, null) as never },
    );
    assert.deepEqual(result, { ok: false, reason: "no_link_targets" });
    assert.equal(puts.length, 0);
  });

  test("checks the targets and writes the store", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(ONE_DOC_SUBNET, null) as never,
        now: () => TICK_MS,
        fetchImpl: fetchDouble({
          "https://docs.example/": { status: 200 },
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked_count, 1);
    assert.equal(result.dead_count, 0);
    assert.equal(puts[0].key, LINK_STATUS_R2_KEY);
    const written = JSON.parse(puts[0].value) as Row;
    assert.equal(written.schema_version, 1);
    assert.equal(written.generated_at, TICK_ISO);
    assert.deepEqual(
      (written.links as LinkStatusRecord[])[0].url,
      "https://docs.example/",
    );
  });

  test("a third consecutive failure is what publishes dead_count", async () => {
    const priorTwo = {
      links: [
        record({
          url: "https://docs.example/",
          classification: "dead",
          consecutive_failures: LINK_DEAD_STRIKES - 1,
        }),
      ],
    };
    const { bucket, puts } = fakeBucket({ [LINK_STATUS_R2_KEY]: priorTwo });
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(ONE_DOC_SUBNET, null) as never,
        now: () => TICK_MS,
        fetchImpl: fetchDouble({
          "https://docs.example/": { status: 404 },
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(result.dead_count, 1);
    const written = JSON.parse(puts[0].value) as Row;
    assert.equal(
      (written.links as LinkStatusRecord[])[0].consecutive_failures,
      LINK_DEAD_STRIKES,
    );
  });

  test("skips GitHub URLs without a token, keeping their prior record intact", async () => {
    const subnetsDoc: Row = {
      subnets: [
        {
          netuid: 1,
          surfaces: [
            {
              id: "sn-1-docs",
              kind: "docs",
              url: "https://docs.example/",
              public_safe: true,
              probe: { enabled: true },
              source_urls: ["https://github.com/o/r"],
            },
          ],
        },
      ],
    };
    const prior = {
      links: [
        record({ url: "https://github.com/o/r", classification: "live" }),
      ],
    };
    const { bucket, puts } = fakeBucket({ [LINK_STATUS_R2_KEY]: prior });
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(subnetsDoc, null) as never,
        now: () => TICK_MS,
        // Only the non-GitHub URL may be fetched; the double throws otherwise.
        fetchImpl: fetchDouble({
          "https://docs.example/": { status: 200 },
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(result.checked_count, 1);
    const written = JSON.parse(puts[0].value) as Row;
    const gh = (written.links as LinkStatusRecord[]).find((l) =>
      l.url.includes("github.com"),
    );
    assert.equal(
      gh?.checked_at,
      "2026-08-01T00:00:00.000Z",
      "an unchecked URL must carry forward, not silently recover or die",
    );
  });

  test("self-hosted URLs are never fetched — the build gate owns them", async () => {
    const subnetsDoc: Row = { subnets: [] };
    const providersDoc: Row = {
      providers: [
        { slug: "acme", logo_url: "https://metagraph.sh/logos/acme.png" },
      ],
    };
    const { bucket } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(subnetsDoc, providersDoc) as never,
        now: () => TICK_MS,
        // Any fetch at all fails the test.
        fetchImpl: fetchDouble({}) as unknown as typeof fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked_count, 0);
  });

  test("an unreadable providers artifact costs only the provider population", async () => {
    const { bucket } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(ONE_DOC_SUBNET, null) as never,
        now: () => TICK_MS,
        fetchImpl: fetchDouble({
          "https://docs.example/": { status: 200 },
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked_count, 1);
  });

  test("a thrown tick is contained and reported to telemetry", async () => {
    const recordException = vi.fn(async () => true);
    const waitUntil = vi.fn();
    const result = await runLinkStatusSync(
      mockEnv({
        METAGRAPH_ARCHIVE: {
          get: async () => {
            throw new Error("r2 down");
          },
          put: async () => undefined,
        },
      }),
      { waitUntil },
      {
        readArtifact: vi.fn(async () => {
          throw new Error("reader exploded");
        }) as never,
        recordException: recordException as never,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
    assert.equal(waitUntil.mock.calls.length, 1);
    assert.equal(recordException.mock.calls.length, 1);
  });

  test("a cold prior store degrades to a first run rather than throwing", async () => {
    const { bucket } = fakeBucket();
    bucket.get = async () => {
      throw new Error("cold");
    };
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        readArtifact: artifactStub(ONE_DOC_SUBNET, null) as never,
        now: () => TICK_MS,
        fetchImpl: fetchDouble({
          "https://docs.example/": { status: 200 },
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(result.ok, true);
  });
});

// --- registration ------------------------------------------------------------

describe("cron registration", () => {
  test("the registered cron matches the wrangler trigger", async () => {
    // A constant that drifts from wrangler.jsonc means the branch is dead in
    // production while every test here still passes.
    const { LINK_STATUS_SYNC_CRON } = await import("../workers/config.ts");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${LINK_STATUS_SYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${LINK_STATUS_SYNC_CRON}`,
    );
  });

  test("it runs after github-signals, which shares its token budget", async () => {
    const { GITHUB_SIGNALS_SYNC_CRON, LINK_STATUS_SYNC_CRON } =
      await import("../workers/config.ts");
    const minutes = (cron: string) => {
      const [minute, hour] = cron.split(" ");
      return Number(hour) * 60 + Number(minute);
    };
    assert.ok(
      minutes(LINK_STATUS_SYNC_CRON) > minutes(GITHUB_SIGNALS_SYNC_CRON),
      "both lanes draw on the same GitHub rate limit; overlapping them risks 429s on both",
    );
  });

  test("the daily cron dispatches to it end-to-end through the Worker entry point", async () => {
    // Registering the trigger in wrangler.jsonc without wiring the branch
    // would fire a cron into a silent no-op forever.
    const { default: worker } = await import("../workers/api.ts");
    const { LINK_STATUS_SYNC_CRON } = await import("../workers/config.ts");
    const { store, bucket } = fakeBucket({
      // The real readArtifact resolves /metagraph/subnets.json through the
      // literal latest/ prefix when no publish pointer exists.
      "latest/subnets.json": ONE_DOC_SUBNET,
    });
    vi.stubGlobal(
      "fetch",
      fetchDouble({ "https://docs.example/": { status: 200 } }),
    );
    const waited: Promise<unknown>[] = [];
    const result = (await worker.scheduled(
      { cron: LINK_STATUS_SYNC_CRON, scheduledTime: TICK_MS } as never,
      mockEnv({ METAGRAPH_ARCHIVE: bucket }) as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    )) as { ok: boolean };
    await Promise.all(waited);
    assert.equal(result.ok, true);
    // Proof the branch ran: only this cron writes the link-status store key.
    assert.ok(store.has(LINK_STATUS_R2_KEY));
  });
});

describe("telemetry failure containment", () => {
  test("a rejecting recordException cannot take the cron down with it", async () => {
    // The catch on the telemetry promise is the difference between "one stale
    // day" and an unhandled rejection in a scheduled handler.
    const result = await runLinkStatusSync(
      mockEnv({
        METAGRAPH_ARCHIVE: {
          get: async () => null,
          put: async () => undefined,
        },
      }),
      { waitUntil: (p: Promise<unknown>) => p },
      {
        readArtifact: vi.fn(async () => {
          throw new Error("reader exploded");
        }) as never,
        recordException: (async () => {
          throw new Error("posthog is down too");
        }) as never,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
  });
});

describe("degenerate inputs", () => {
  test("an idless surface and a slugless provider still yield checkable targets", () => {
    const targets = collectLinkTargets(
      [
        {
          netuid: 3,
          surfaces: [
            {
              kind: "docs",
              url: "https://noid.example/",
              public_safe: true,
              probe: { enabled: true },
              source_urls: ["https://noid.example/readme"],
            },
          ],
        },
      ] as Row[],
      [{ website_url: "https://noslug.example/" }] as Row[],
      OP_KINDS,
    );
    assert.deepEqual(targets.map((t) => t.url).sort(), [
      "https://noid.example/",
      "https://noid.example/readme",
      "https://noslug.example/",
    ]);
    // An empty id must not silently join every idless surface together.
    assert.deepEqual(
      targets.find((t) => t.url === "https://noid.example/")?.citations,
      [{ kind: "surface", id: "", netuid: 3 }],
    );
  });

  test("artifacts missing their collection key degrade to empty, not to a throw", async () => {
    const { bucket } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      {
        // subnets artifact ok but with no `subnets` key; providers ok but with
        // no `providers` key.
        readArtifact: vi.fn(async () => ({
          ok: true,
          data: {},
          source: "r2",
          storage_tier: "dual",
        })) as never,
        now: () => TICK_MS,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "no_link_targets" });
  });

  test("URLs never checked before are ordered deterministically among themselves", () => {
    // Equal (absent) timestamps must fall back to a stable key, or the per-run
    // selection would differ between ticks for no reason.
    assert.deepEqual(urlsForRun(["b", "a", "c"], new Map(), 2), ["a", "b"]);
  });

  test("a configured token is sent, and the GitHub subset is checked", async () => {
    const subnetsDoc: Row = {
      subnets: [
        {
          netuid: 1,
          surfaces: [
            {
              id: "s",
              kind: "docs",
              url: "https://github.com/o/r",
              public_safe: true,
              probe: { enabled: true },
            },
          ],
        },
      ],
    };
    const calls: Array<{ url: string; method: string; headers: unknown }> = [];
    const { bucket } = fakeBucket();
    const result = await runLinkStatusSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket, GITHUB_SIGNALS_TOKEN: "  tok  " }),
      undefined,
      {
        readArtifact: artifactStub(subnetsDoc, null) as never,
        now: () => TICK_MS,
        fetchImpl: fetchDouble(
          { "https://api.github.com/repos/o/r": { status: 200 } },
          calls,
        ) as unknown as typeof fetch,
      },
    );
    assert.equal(result.checked_count, 1);
    assert.equal(
      (calls[0].headers as Row).authorization,
      "Bearer tok",
      "the token is trimmed before use",
    );
  });
});

describe("default dependencies", () => {
  test("falls back to global fetch when no fetchImpl is injected", async () => {
    const calls: Array<{ url: string; headers: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: Row) => {
        calls.push({ url: String(url), headers: init?.headers });
        return new Response(null, { status: 200 });
      }),
    );
    const result = await checkLink("https://github.com/o/r", {
      githubAuth: "Bearer t",
    });
    assert.equal(result.classification, "live");
    assert.equal(calls[0].url, "https://api.github.com/repos/o/r");
    assert.equal((calls[0].headers as Row).authorization, "Bearer t");
  });

  test("falls back to the real telemetry recorder when none is injected", async () => {
    // Exercises the `?? recordExceptionEvent` arm: the cron must still contain
    // the failure with the production recorder in place, not just the double.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const result = await runLinkStatusSync(
      mockEnv({
        METAGRAPH_ARCHIVE: {
          get: async () => null,
          put: async () => undefined,
        },
      }),
      { waitUntil: (p: Promise<unknown>) => p },
      {
        readArtifact: vi.fn(async () => {
          throw new Error("reader exploded");
        }) as never,
      },
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
  });
});
