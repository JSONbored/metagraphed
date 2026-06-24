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
