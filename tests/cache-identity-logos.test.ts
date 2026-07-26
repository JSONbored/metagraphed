import assert from "node:assert/strict";
import { test } from "vitest";

import {
  classifyLogoUrl,
  collectIdentityLogoUrls,
  retainPreviousEntry,
  validateLogoBody,
} from "../scripts/cache-identity-logos.ts";

// #8288. These inputs are ON-CHAIN IDENTITY: whoever registers a subnet chooses
// the string, so every guard here is defending against attacker-controllable
// text, not against typos. The pure functions are split out of the fetch for
// exactly this reason — the policy is assertable without network.

test("rejects non-http(s) schemes outright", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.org/logo.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
  ]) {
    const c = classifyLogoUrl(url);
    assert.equal(c.attempt, false, `${url} must not be fetched`);
    assert.equal(c.attempt === false && c.reason, "unsafe-url");
  }
});

test("rejects unparseable and empty values", () => {
  for (const v of ["", "   ", "not a url", null, undefined, 42, {}]) {
    assert.equal(classifyLogoUrl(v).attempt, false);
  }
});

test("skips placeholder identity URLs rather than caching junk", () => {
  const c = classifyLogoUrl("https://example.com/logo.png");
  assert.equal(c.attempt, false);
  assert.equal(c.attempt === false && c.reason, "placeholder");
});

test("skips URLs already on our own origin — re-caching would double the bytes", () => {
  const c = classifyLogoUrl("https://metagraph.sh/logos/affine.png");
  assert.equal(c.attempt, false);
  assert.equal(c.attempt === false && c.reason, "already-first-party");
});

test("accepts a genuine third-party image URL", () => {
  const c = classifyLogoUrl(
    "https://raw.githubusercontent.com/org/repo/main/logo.png",
  );
  assert.equal(c.attempt, true);
});

// --- body validation -------------------------------------------------------

const bytes = (n: number) => new Uint8Array(n);

test("content-type allowlist rejects a 200-with-HTML error page", () => {
  // The common real failure: a dead CDN path returns 200 and an HTML body.
  // Without this guard it would be cached and render as a broken icon.
  const v = validateLogoBody("text/html; charset=utf-8", bytes(1024));
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "bad-content-type");
});

test("content-type allowlist rejects absent and non-image types", () => {
  for (const ct of [null, "", "application/json", "application/octet-stream"]) {
    assert.equal(validateLogoBody(ct, bytes(64)).ok, false);
  }
});

test("accepts the image types a browser renders, and maps the extension", () => {
  const cases: Array<[string, string]> = [
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/svg+xml", "svg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
    ["image/x-icon", "ico"],
  ];
  for (const [ct, ext] of cases) {
    const v = validateLogoBody(ct, bytes(64));
    assert.equal(v.ok, true, ct);
    assert.equal(v.ok === true && v.ext, ext);
  }
});

test("tolerates content-type parameters and casing", () => {
  const v = validateLogoBody("IMAGE/PNG; charset=binary", bytes(64));
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.contentType, "image/png");
});

test("size cap rejects an oversized body, boundary is inclusive", () => {
  const cap = 512 * 1024;
  assert.equal(
    validateLogoBody("image/png", bytes(cap)).ok,
    true,
    "exactly at cap is fine",
  );
  const over = validateLogoBody("image/png", bytes(cap + 1));
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, "too-large");
});

test("rejects an empty body even with a valid image content-type", () => {
  const v = validateLogoBody("image/png", bytes(0));
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "empty");
});

// --- collection ------------------------------------------------------------

test("collects logo_url from nested identity snapshots, deduped", () => {
  const urls = collectIdentityLogoUrls([
    {
      subnets: [
        { netuid: 1, chain_identity: { logo_url: "https://a.example/a.png" } },
        { netuid: 2, chain_identity: { logo_url: "https://b.example/b.png" } },
        { netuid: 3, chain_identity: { logo_url: "https://a.example/a.png" } },
        { netuid: 4, chain_identity: { github_repo: "https://c.example" } },
      ],
    },
  ]);
  assert.deepEqual(urls.sort(), [
    "https://a.example/a.png",
    "https://b.example/b.png",
  ]);
});

test("collecting from an empty or malformed snapshot yields nothing, never throws", () => {
  assert.deepEqual(collectIdentityLogoUrls([]), []);
  assert.deepEqual(
    collectIdentityLogoUrls([null, 42, "x", { subnets: [] }]),
    [],
  );
});

// --- sticky-cache manifest reuse (build robustness) -------------------------
// A prior entry must survive a transient fetch failure at the NEXT build, so a
// single network blip cannot silently demote a subnet's logo to a monogram.

const entry = (path: string) => ({
  source_url: "https://example.org/logo.png",
  cached_path: path,
  sha256: "abc123",
  content_type: "image/png",
  size_bytes: 1024,
});

test("retains a prior entry when the fetch just failed and the file is still on disk", () => {
  const kept = retainPreviousEntry(
    entry("/logos/cache/abc123.png"),
    () => true,
  );
  assert.deepEqual(kept, entry("/logos/cache/abc123.png"));
});

test("does not retain when there is no prior entry — a first-ever miss is a real miss", () => {
  assert.equal(
    retainPreviousEntry(undefined, () => true),
    null,
  );
});

test("does not retain a prior entry whose cached file is gone — no phantom logo_url", () => {
  const kept = retainPreviousEntry(
    entry("/logos/cache/abc123.png"),
    () => false,
  );
  assert.equal(kept, null);
});

test("the exists probe is asked about the PRIOR entry's own path, not some other one", () => {
  let asked: string | undefined;
  retainPreviousEntry(entry("/logos/cache/deadbeef.png"), (p) => {
    asked = p;
    return true;
  });
  assert.equal(asked, "/logos/cache/deadbeef.png");
});
