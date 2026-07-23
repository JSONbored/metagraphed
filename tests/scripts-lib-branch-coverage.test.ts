import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildEvidenceSubjectNetuidIndex,
  netuidForEvidenceClaim,
  loadSubnets,
  stripJsonComments,
  artifactOutputPath,
  createLocalArtifactEnv,
  sanitizeOpenApiDocument,
  safeFetch,
  sanitizeFixtureBody,
  fixtureCaptureFailureReason,
  surfaceFixtureReference,
  normalizePublicHttpUrl,
  socialAccounts,
  registrySurfaceKey,
  isHtmlContentType,
  buildSubnetLineageLinks,
  clusterDomainFromUrl,
  registrableHostDomain,
  buildProvenanceReviewQueue,
  deriveAuthDetail,
  publishedAt,
  staleOperationalKinds,
} from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

describe("buildEvidenceSubjectNetuidIndex", () => {
  test("indexes subnet/surface/candidate subjects and skips non-integer netuids", () => {
    const index = buildEvidenceSubjectNetuidIndex({
      subnets: [{ netuid: 4 }, { netuid: 1.5 }, { netuid: null }],
      surfaces: [{ id: "all-ways-api", netuid: 7 }],
      candidates: [{ id: "cand-1", netuid: 12 }],
    });
    // subnet:4 stored; the float / null netuid rows are rejected by the
    // Number.isInteger guard and never indexed.
    assert.equal(index.get("subnet:4"), 4);
    assert.equal(index.get("surface:all-ways-api"), 7);
    assert.equal(index.get("candidate:cand-1"), 12);
    assert.equal(index.has("subnet:1.5"), false);
    assert.equal(index.has("subnet:null"), false);
  });

  test("tolerates explicitly null subject lists via the `|| []` guards", () => {
    const index = buildEvidenceSubjectNetuidIndex({
      subnets: null,
      surfaces: null,
      candidates: null,
    } as unknown as Parameters<typeof buildEvidenceSubjectNetuidIndex>[0]);
    assert.equal(index.size, 0);
  });
});

describe("netuidForEvidenceClaim", () => {
  test("falls back to parsing the subject when the index misses", () => {
    assert.equal(netuidForEvidenceClaim({ subject: "subnet:42" }), 42);
    assert.equal(netuidForEvidenceClaim({ subject: "sn-7-openapi" }), 7);
    assert.equal(netuidForEvidenceClaim({}), null);
  });
});

describe("registry loaders (filesystem-backed)", () => {
  test("loadSubnets returns subnets sorted by netuid then slug", async () => {
    const subnets = (await loadSubnets()) as unknown as Row[];
    assert.ok(Array.isArray(subnets) && subnets.length > 0);
    for (let i = 1; i < subnets.length; i += 1) {
      const prev = subnets[i - 1];
      const cur = subnets[i];
      // netuid asc, with slug as the tiebreak (exercises both comparator arms).
      assert.ok(
        prev.netuid < cur.netuid ||
          (prev.netuid === cur.netuid &&
            prev.slug.localeCompare(cur.slug) <= 0),
      );
    }
  });
});

describe("stripJsonComments", () => {
  test("tolerates a dangling backslash at the very end of input (?? '' arms)", () => {
    // The backslash is the final char, so `next` is undefined and the
    // `next ?? ""` escape-append arms take the "" branch.
    // Walk both passes by giving a string region that reaches end mid-escape.
    assert.equal(typeof stripJsonComments('"a\\'), "string");
    assert.equal(typeof stripJsonComments('{"a":"b",}\\'), "string");
  });
});

describe("artifactOutputPath", () => {
  test("routes a git-tier artifact to the public metagraph root (else arm)", () => {
    const out = artifactOutputPath("contracts.json");
    assert.ok(out.endsWith("contracts.json"));
    assert.ok(out.includes("public"));
  });
});

describe("createLocalArtifactEnv", () => {
  test("ASSETS.fetch serves a non-json asset as octet-stream", async () => {
    const env = createLocalArtifactEnv() as unknown as Row;
    const res = await env.ASSETS.fetch(
      new Request("https://local/favicon.svg"),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
  });
});

describe("sanitizeOpenApiDocument", () => {
  test("recurses into arrays and drops undefined entries", () => {
    // Array branch: an undefined nested result is filtered out.
    const out = sanitizeOpenApiDocument([
      { url: "https://api.example.com/v1" },
      "https://example.com/ok",
    ]);
    assert.deepEqual(out, [
      { url: "https://api.example.com/v1" },
      "https://example.com/ok",
    ]);
  });

  test("returns non-string scalars unchanged", () => {
    assert.equal(sanitizeOpenApiDocument(7), 7);
    assert.equal(sanitizeOpenApiDocument(true), true);
    assert.equal(sanitizeOpenApiDocument(null), null);
  });

  test("runs the `String(key || '')` falsy arm for an empty-string key", () => {
    // The empty-string key flows through isSchemaExtensionKey (exercising the
    // `key || ""` falsy arm), then sanitizeSchemaKey yields "" → the key is
    // dropped by the `!sanitizedKey` guard. The retained sibling proves the
    // walk completed rather than throwing.
    const out = sanitizeOpenApiDocument({
      "": "x",
      keep: "https://example.com/ok",
    }) as Row;
    assert.equal("" in out, false);
    assert.equal(out.keep, "https://example.com/ok");
  });

  test("recurses into a non-object server entry (sanitizeSchemaServer fallback)", () => {
    // A string inside servers[] is not a {url} object → sanitizeSchemaServer
    // delegates straight to sanitizeOpenApiDocument.
    const out = sanitizeOpenApiDocument({
      servers: ["https://api.example.com/ok", { url: "/relative" }],
    }) as Row;
    assert.deepEqual(out.servers, [
      "https://api.example.com/ok",
      { url: "/relative" },
    ]);
  });

  test("drops a plain object property whose value is undefined", () => {
    // nested === undefined → sanitizeOpenApiDocument returns undefined → the
    // property is dropped by the `sanitizedNested === undefined` guard.
    const out = sanitizeOpenApiDocument({ keep: "x", gone: undefined }) as Row;
    assert.equal(out.keep, "x");
    assert.equal("gone" in out, false);
  });
});

describe("safeFetch (error envelope)", () => {
  test("returns a generic error envelope when fetch throws (non-abort)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("boom-network");
    };
    try {
      // A loopback IP literal is its own DNS answer (no resolver needed) and
      // is public-shaped enough to reach the fetch() call, which throws — the
      // catch maps a non-AbortError to error.message.
      const out = await safeFetch("https://8.8.8.8/x");
      assert.equal(out.ok, false);
      assert.equal(out.error, "boom-network");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("maps an AbortError to the 'timeout' error string", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    try {
      const out = await safeFetch("https://8.8.8.8/x");
      assert.equal(out.ok, false);
      assert.equal(out.error, "timeout");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("fires the real timer and calls controller.abort() when the caller passes no signal", async () => {
    const realFetch = globalThis.fetch;
    vi.useFakeTimers();
    globalThis.fetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    try {
      const resultPromise = safeFetch("https://8.8.8.8/x", { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const out = await resultPromise;
      assert.equal(out.ok, false);
      assert.equal(out.error, "timeout");
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
    }
  });
});

describe("sanitizeFixtureBody", () => {
  test("appends a +N-more-keys marker once the key budget is exceeded", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 5; i += 1) big[`k${i}`] = i;
    const out = sanitizeFixtureBody(big, { maxKeys: 2 }) as Row;
    // first two keys kept; the overflow marker is appended.
    assert.equal(out.k0, 0);
    assert.equal(out.k1, 1);
    assert.equal("k2" in out, false);
    assert.equal(out["…"], "[+3 more keys]");
  });
});

describe("fixtureCaptureFailureReason", () => {
  test("maps each known error name to its reason and unknowns to a default", () => {
    assert.equal(
      fixtureCaptureFailureReason({ name: "SyntaxError" }),
      "invalid json response",
    );
    assert.equal(
      fixtureCaptureFailureReason({ name: "AbortError" }),
      "request timed out",
    );
    assert.equal(
      fixtureCaptureFailureReason({ name: "FixtureCaptureLimitError" }),
      "response exceeds byte limit",
    );
    assert.equal(
      fixtureCaptureFailureReason({ name: "TypeError" }),
      "request failed",
    );
    assert.equal(
      fixtureCaptureFailureReason({ name: "OtherError" }),
      "capture failed",
    );
    assert.equal(fixtureCaptureFailureReason(null), "capture failed");
  });
});

describe("surfaceFixtureReference (missing optional fields)", () => {
  test("nulls request.url and response.status/content_type when malformed", () => {
    // request.method non-string → "GET"; request.url non-string → null;
    // response.status non-integer → null; content_type non-string → null.
    const ref = surfaceFixtureReference("sn-1-x", {
      request: { method: 42, url: 99 },
      response: { status: "200", content_type: 5 },
    }) as unknown as Row;
    assert.equal(ref.request.method, "GET");
    assert.equal(ref.request.url, null);
    assert.equal(ref.response.status, null);
    assert.equal(ref.response.content_type, null);
    assert.equal(ref.captured_at, null);
  });

  test("falls back to empty request/response objects when omitted", () => {
    const ref = surfaceFixtureReference("sn-2-y", {}) as unknown as Row;
    assert.equal(ref.request.method, "GET");
    assert.equal(ref.request.url, null);
    assert.equal(ref.response.status, null);
    assert.equal(ref.artifact_path, "/metagraph/fixtures/sn-2-y.json");
  });
});

describe("normalizePublicHttpUrl", () => {
  test("rejects a ws(s) URL that normalizePublicUrl accepts", () => {
    // normalizePublicUrl passes wss:, but the http-only guard rejects it.
    assert.equal(normalizePublicHttpUrl("wss://stream.example.io/feed"), null);
  });
});

describe("socialAccounts (placeholder URL skip)", () => {
  test("skips an extracted social URL that reads as placeholder junk", () => {
    // 'deprecated' is a placeholder identity token, so the matched x.com URL is
    // skipped, leaving no social accounts.
    const out = socialAccounts("follow https://x.com/deprecated-team");
    assert.equal(out, null);
  });

  test("still extracts a legitimate handle alongside a skipped junk one", () => {
    const out = socialAccounts(
      "https://x.com/example.com_junk and https://t.me/realchan",
    );
    // the x.com URL carries the 'example.com' placeholder token → skipped;
    // the telegram one survives.
    assert.deepEqual(out, { telegram: "https://t.me/realchan" });
  });
});

describe("registrySurfaceKey / subnetSurfaceKey", () => {
  test("falls back through netuid/kind/url defaults for a sparse entry", () => {
    // entry with no netuid, no kind, and an unnormalizable url exercises all
    // three `?? / ||` fallback arms.
    assert.equal(
      registrySurfaceKey({ url: "not a url" }),
      "unknown|unknown|not a url",
    );
    assert.equal(registrySurfaceKey({}), "unknown|unknown|unknown");
  });
});

describe("isHtmlContentType / isJsonContentType", () => {
  test("detects html and tolerates non-string input", () => {
    assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
    assert.equal(isHtmlContentType("application/json"), false);
    assert.equal(isHtmlContentType(null), false);
    assert.equal(isHtmlContentType(42), false);
  });
});

describe("buildSubnetLineageLinks (broken-link arms)", () => {
  const sub = (netuid: unknown, name: unknown) => ({
    netuid,
    name,
    raw_name: name,
    chain_identity: { subnet_name: name },
  });

  test("records null source/target netuids on a wholly malformed approval", () => {
    const broken: Row[] = [];
    const links = buildSubnetLineageLinks(
      [sub(1, "A")],
      [sub(2, "B")],
      [{ matched_by: "github_repo" }], // no netuids at all
      broken,
    );
    assert.deepEqual(links, []);
    // both `Number.isInteger(...) ? ... : null` arms take the null branch;
    // reason invalid-approval.
    assert.deepEqual(broken, [
      { source_netuid: null, target_netuid: null, reason: "invalid-approval" },
    ]);
  });

  test("accepts mainnet_/testnet_ netuid aliases (the ?? fallback arms)", () => {
    const links = buildSubnetLineageLinks(
      [sub(1, "A")],
      [sub(2, "B")],
      [{ mainnet_netuid: 1, testnet_netuid: 2, matched_by: "chain_name" }],
    );
    assert.deepEqual(links, [
      { source_netuid: 1, target_netuid: 2, matched_by: "chain_name" },
    ]);
  });

  test("surfaces a source-netuid-missing approval", () => {
    const broken: Row[] = [];
    buildSubnetLineageLinks(
      [sub(1, "A")],
      [sub(2, "B")],
      [{ source_netuid: 99, target_netuid: 2, matched_by: "github_repo" }],
      broken,
    );
    assert.deepEqual(broken, [
      { source_netuid: 99, target_netuid: 2, reason: "source-netuid-missing" },
    ]);
  });

  test("dedupes a repeated identical approval", () => {
    const links = buildSubnetLineageLinks(
      [sub(1, "A")],
      [sub(2, "B")],
      [
        { source_netuid: 1, target_netuid: 2, matched_by: "chain_name" },
        { source_netuid: 1, target_netuid: 2, matched_by: "github_repo" },
      ],
    );
    // second (duplicate netuid pair) is skipped by the seen-set guard.
    assert.deepEqual(links, [
      { source_netuid: 1, target_netuid: 2, matched_by: "chain_name" },
    ]);
  });

  test("tiebreaks equal source_netuid links by target_netuid", () => {
    // one source maps to two distinct targets → the primary comparator returns
    // 0, so the `|| a.target_netuid - b.target_netuid` arm decides the order.
    const links = buildSubnetLineageLinks(
      [sub(1, "A")],
      [sub(3, "C"), sub(2, "B")],
      [
        { source_netuid: 1, target_netuid: 3, matched_by: "chain_name" },
        { source_netuid: 1, target_netuid: 2, matched_by: "github_repo" },
      ],
    );
    assert.deepEqual(
      links.map((l) => l.target_netuid),
      [2, 3],
    );
  });

  test("defaults approvedLinks to [] when passed null", () => {
    // null approvals → the `approvedLinks || []` guard yields an empty loop.
    assert.deepEqual(
      buildSubnetLineageLinks(
        [sub(1, "A")],
        [sub(2, "B")],
        null as unknown as Row[],
      ),
      [],
    );
  });
});

describe("clusterDomainFromUrl (appspot tenant arms)", () => {
  test("returns null for a bare proj-less appspot.com", () => {
    // appspot.com with <3 labels → null.
    assert.equal(clusterDomainFromUrl("https://appspot.com"), null);
  });

  test("returns the single label for a one-label host", () => {
    // labels.length < 2 → `return host || null`; host is truthy here.
    assert.equal(clusterDomainFromUrl("https://localhost/x"), "localhost");
  });

  test("returns null when the host strips to empty", () => {
    // "www." hostname → strip leading www. → "" → labels [] → length < 2 →
    // `host || null` with an empty host takes the null arm.
    assert.equal(clusterDomainFromUrl("https://www./"), null);
  });
});

describe("registrableHostDomain (last-two-label fallback)", () => {
  test("falls back to last-two labels when cluster resolution yields null", () => {
    // A bare multi-tenant suffix (no tenant) makes clusterDomainFromUrl return
    // null, so the `?? labels.slice(-2)` fallback runs.
    assert.equal(registrableHostDomain("pages.dev"), "pages.dev");
    assert.equal(registrableHostDomain("github.io"), "github.io");
  });

  test("returns the single label unchanged when there is no dot", () => {
    // <2 labels → the `: host` arm of the inner ternary.
    assert.equal(registrableHostDomain("localhost"), "localhost");
  });
});

describe("buildProvenanceReviewQueue", () => {
  const candidate = {
    id: "c-openapi",
    netuid: 7,
    kind: "openapi",
    url: "https://api.team.io/openapi.json",
    source_type: "openapi-probe",
    slug: "sn-7-team",
  };
  const native = {
    netuid: 7,
    chain_identity: { subnet_url: "https://team.io" },
  };
  const verification = {
    candidate_id: "c-openapi",
    classification: "live",
    quality_signals: { content_type_matches_kind: true },
  };

  test("queues a provenance-strong subnet absent from the subnets level map", () => {
    // subnets=[] → both levelByNetuid.get and slugByNetuid.get miss, so the
    // `?? entry.slug` / `?? null` fallbacks run.
    const out = buildProvenanceReviewQueue({
      candidates: [candidate],
      nativeSubnets: [native],
      verificationResults: [verification],
      subnets: [],
      generatedAt: "1970-01-01T00:00:00.000Z",
    }) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.queue.length, 1);
    const [row] = out.queue;
    assert.equal(row.netuid, 7);
    assert.equal(row.slug, "sn-7-team"); // entry.slug fallback
    assert.equal(row.current_level, null); // ?? null fallback
    assert.deepEqual(row.kinds, ["openapi"]);
    assert.equal(row.domain, "team.io");
    assert.match(row.rationale, /Strong provenance/);
  });

  test("synthesizes an sn-<netuid> slug when neither map nor entry has one", () => {
    const out = buildProvenanceReviewQueue({
      candidates: [{ ...candidate, slug: undefined }],
      nativeSubnets: [native],
      verificationResults: [verification],
      subnets: [],
      generatedAt: "1970-01-01T00:00:00.000Z",
    }) as Row;
    assert.equal(out.queue[0].slug, "sn-7");
  });

  test("maps a known subnet that has no curation block (level `?? null` arm)", () => {
    // subnet present in the level map but with no curation → the
    // `subnet.curation?.level ?? null` fallback yields null, and
    // the slug map hits (so slugByNetuid wins over entry.slug).
    const out = buildProvenanceReviewQueue({
      candidates: [candidate],
      nativeSubnets: [native],
      verificationResults: [verification],
      subnets: [{ netuid: 7, slug: "registry-slug" }],
      generatedAt: "1970-01-01T00:00:00.000Z",
    }) as Row;
    assert.equal(out.queue.length, 1);
    assert.equal(out.queue[0].current_level, null);
    assert.equal(out.queue[0].slug, "registry-slug");
  });
});

describe("deriveAuthDetail (selection + default arms)", () => {
  test("apiKey with an unrecognized `in` defaults the location to header", () => {
    //  false arm: `in` not in [header,query,cookie] → "header".
    const out = deriveAuthDetail({
      k: { type: "apiKey", in: "body", name: "X-Key" },
    }) as Row;
    assert.equal(out.location, "header");
    assert.equal(out.scheme, "api-key");
  });

  test("http with no scheme defaults to bearer (the `|| ''` arm)", () => {
    // String(pick.scheme || "") falsy arm, then non-basic → bearer.
    const out = deriveAuthDetail({ b: { type: "http" } }) as Row;
    assert.equal(out.scheme, "bearer");
    assert.equal(out.value_format, "Bearer <token>");
  });

  test("a scheme entry with no type falls through to null", () => {
    // entries[0] is picked, type = String(undefined || "") = "" via the
    // `|| ""` arm, matches no branch → null.
    assert.equal(deriveAuthDetail({ only: { foo: 1 } }), null);
  });

  test("oauth2 with a flow lacking both URLs falls back to scheme.tokenUrl", () => {
    // The clientCredentials flow has neither tokenUrl nor authorizationUrl, so
    // both in-loop guards take their false arm, then the
    // top-level scheme.tokenUrl resolves.
    const out = deriveAuthDetail({
      o: {
        type: "oauth2",
        flows: { clientCredentials: {} },
        tokenUrl: "https://auth.example.com/token",
      },
    }) as Row;
    assert.equal(out.token_url, "https://auth.example.com/token");
  });
});

describe("publishedAt", () => {
  test("returns the trimmed env value or null when unset", () => {
    const prev = process.env.METAGRAPH_PUBLISHED_AT;
    try {
      process.env.METAGRAPH_PUBLISHED_AT = "  2026-06-27T00:00:00Z  ";
      assert.equal(publishedAt(), "2026-06-27T00:00:00Z");
      delete process.env.METAGRAPH_PUBLISHED_AT;
      assert.equal(publishedAt(), null);
      process.env.METAGRAPH_PUBLISHED_AT = "   ";
      assert.equal(publishedAt(), null);
    } finally {
      if (prev === undefined) delete process.env.METAGRAPH_PUBLISHED_AT;
      else process.env.METAGRAPH_PUBLISHED_AT = prev;
    }
  });
});

describe("staleOperationalKinds", () => {
  const ref = "2026-06-24T00:00:00Z";

  test("treats a kind with a row that has no last_ok as unverified → stale", () => {
    // row.status ok but last_ok missing → okMs NaN → not verifiedFresh.
    const stale = staleOperationalKinds({
      operationalKinds: ["openapi"],
      healthByKind: new Map([["openapi", [{ status: "ok", last_ok: null }]]]),
      probeFinishedAt: ref,
    });
    assert.equal(stale.has("openapi"), true);
  });

  test("defaults operationalKinds to [] when omitted", () => {
    const stale = staleOperationalKinds({
      operationalKinds: null as unknown as string[],
      healthByKind: { openapi: [{ status: "ok", last_ok: ref }] },
      probeFinishedAt: ref,
    });
    assert.equal(stale.size, 0);
  });
});
