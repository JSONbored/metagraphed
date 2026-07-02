import assert from "node:assert/strict";
import { test } from "vitest";
import { applyQueryFilters } from "../workers/list-query.mjs";

// Per-subnet economics rows (a subset of the /api/v1/economics blob shape).
const blob = {
  subnets: [
    {
      netuid: 1,
      name: "apex",
      validator_count: 50,
      registration_allowed: true,
    },
    {
      netuid: 2,
      name: "beta",
      validator_count: 10,
      registration_allowed: false,
    },
    {
      netuid: 3,
      name: "gamma",
      validator_count: 90,
      registration_allowed: true,
    },
  ],
};

test("economics collection ranks by validator_count desc (#1313)", () => {
  const url = new URL(
    "https://x/api/v1/economics?sort=validator_count&order=desc",
  );
  const { data } = applyQueryFilters(blob, url, "economics", []);
  assert.deepEqual(
    data.subnets.map((s) => s.netuid),
    [3, 1, 2],
  );
});

test("economics collection filters by registration_allowed (boolean as string)", () => {
  const url = new URL("https://x/api/v1/economics?registration_allowed=true");
  const { data } = applyQueryFilters(blob, url, "economics", []);
  assert.deepEqual(data.subnets.map((s) => s.netuid).sort(), [1, 3]);
});

test("economics collection searches by name", () => {
  const url = new URL("https://x/api/v1/economics?q=gamma");
  const { data } = applyQueryFilters(blob, url, "economics", []);
  assert.deepEqual(
    data.subnets.map((s) => s.netuid),
    [3],
  );
});

test("economics collection passes the blob through unchanged with no query", () => {
  const url = new URL("https://x/api/v1/economics");
  const { data } = applyQueryFilters(blob, url, "economics", []);
  assert.equal(data.subnets.length, 3);
});
