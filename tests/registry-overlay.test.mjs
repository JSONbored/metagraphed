import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeSurfaceSourceUrls } from "../src/registry-overlay.mjs";

// ---- Surface source_url(s) shape reconciliation (#4697) --------------------

test("surface with only source_urls (current shape) returns the array unchanged", () => {
  const surface = { source_urls: ["https://example.com/readme"] };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), [
    "https://example.com/readme",
  ]);
});

test("surface with only legacy source_url (theoretical/historical shape) returns [source_url]", () => {
  const surface = { source_url: "https://example.com/legacy" };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), [
    "https://example.com/legacy",
  ]);
});

test("surface with both keys present: plural wins, singular ignored", () => {
  const surface = {
    source_urls: ["https://example.com/current"],
    source_url: "https://example.com/legacy",
  };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), [
    "https://example.com/current",
  ]);
});

test("surface with neither key returns [] and does not fall through to .url", () => {
  const surface = { url: "https://example.com/api" };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), []);
});

test("does not pick up a subnet's links[].source_url when the surface itself has neither key", () => {
  // A surface object never legitimately contains its parent subnet's links[]
  // array, but assert explicitly that a same-shaped sibling field is never
  // consulted -- links[].source_url is a distinct, unrelated field
  // (schemas/subnet-manifest.schema.json's link $def), not an alternate
  // spelling of a surface's own citation.
  const surface = {
    url: "https://example.com/api",
    links: [{ label: "Docs", source_url: "https://example.com/docs-src" }],
  };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), []);
});

test('an empty-string legacy source_url is treated as absent, not [""]', () => {
  assert.deepEqual(normalizeSurfaceSourceUrls({ source_url: "" }), []);
});

test("a non-array source_urls (malformed) falls through to the singular check", () => {
  const surface = {
    source_urls: "not-an-array",
    source_url: "https://example.com/legacy",
  };
  assert.deepEqual(normalizeSurfaceSourceUrls(surface), [
    "https://example.com/legacy",
  ]);
});

test("null/undefined/non-object input returns [] without throwing", () => {
  assert.deepEqual(normalizeSurfaceSourceUrls(null), []);
  assert.deepEqual(normalizeSurfaceSourceUrls(undefined), []);
  assert.deepEqual(normalizeSurfaceSourceUrls("not-an-object"), []);
});
