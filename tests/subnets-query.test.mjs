import assert from "node:assert/strict";
import { test } from "vitest";
import { applyQueryFilters } from "../workers/list-query.mjs";

// A subset of the /api/v1/subnets index row shape (name + slug are the
// searchable keys; both are projected onto every index row).
const blob = {
  subnets: [
    { netuid: 1, name: "Apex", slug: "apex" },
    { netuid: 4, name: "Targon", slug: "targon" },
    { netuid: 64, name: "Chutes", slug: "chutes" },
  ],
};

test("subnets collection searches by name (case-insensitive)", () => {
  const url = new URL("https://x/api/v1/subnets?q=targ");
  const { data } = applyQueryFilters(blob, url, "subnets", []);
  assert.deepEqual(
    data.subnets.map((s) => s.netuid),
    [4],
  );
});

test("subnets collection searches by slug", () => {
  const url = new URL("https://x/api/v1/subnets?q=chutes");
  const { data } = applyQueryFilters(blob, url, "subnets", []);
  assert.deepEqual(
    data.subnets.map((s) => s.netuid),
    [64],
  );
});

test("subnets collection returns no rows when q matches neither name nor slug", () => {
  const url = new URL("https://x/api/v1/subnets?q=nonesuch");
  const { data } = applyQueryFilters(blob, url, "subnets", []);
  assert.equal(data.subnets.length, 0);
});

test("subnets collection passes the blob through unchanged with no query", () => {
  const url = new URL("https://x/api/v1/subnets");
  const { data } = applyQueryFilters(blob, url, "subnets", []);
  assert.equal(data.subnets.length, 3);
});

// Multi-term ?q= matches each whitespace-separated term independently (AND),
// order-independent across the searchable fields.
const multiBlob = {
  subnets: [
    { netuid: 1, name: "Apex", slug: "apex" },
    { netuid: 4, name: "Targon", slug: "targon" },
    { netuid: 7, name: "Text Generation", slug: "text-gen" },
    { netuid: 64, name: "Chutes", slug: "chutes" },
  ],
};
const ids = (data) => data.subnets.map((s) => s.netuid);

test("multi-term q matches all terms regardless of order", () => {
  const url = new URL("https://x/api/v1/subnets?q=generation%20text");
  const { data } = applyQueryFilters(multiBlob, url, "subnets", []);
  // The reversed phrase would never match as one contiguous substring; both
  // terms are present, so the row matches.
  assert.deepEqual(ids(data), [7]);
});

test("multi-term q requires every term (AND, not OR)", () => {
  const url = new URL("https://x/api/v1/subnets?q=targon%20chutes");
  const { data } = applyQueryFilters(multiBlob, url, "subnets", []);
  // No single row contains both terms.
  assert.equal(data.subnets.length, 0);
});

test("a single term keeps the original substring behaviour", () => {
  const url = new URL("https://x/api/v1/subnets?q=gen");
  const { data } = applyQueryFilters(multiBlob, url, "subnets", []);
  assert.deepEqual(ids(data), [7]); // matches the "text-gen" slug
});

test("a whitespace-only q is treated as no search, not a space match", () => {
  const url = new URL("https://x/api/v1/subnets?q=%20%20");
  const { data } = applyQueryFilters(multiBlob, url, "subnets", []);
  // Previously the lone space matched only rows whose joined fields contain a
  // space ("Text Generation"); now an empty term list means no filtering.
  assert.deepEqual(ids(data), [1, 4, 7, 64]);
});
