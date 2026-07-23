import assert from "node:assert/strict";
import { test } from "vitest";
import { applyQueryFilters } from "../workers/list-query.ts";
import type { Row } from "./row-type.ts";

// Per-subnet economics rows (a subset of the /api/v1/economics blob shape).
const blob = {
  subnets: [
    {
      netuid: 1,
      name: "apex",
      validator_count: 50,
      alpha_market_cap_tao: 25,
      registration_allowed: true,
    },
    {
      netuid: 2,
      name: "beta",
      validator_count: 10,
      alpha_market_cap_tao: null,
      registration_allowed: false,
    },
    {
      netuid: 3,
      name: "gamma",
      validator_count: 90,
      alpha_market_cap_tao: 100,
      registration_allowed: true,
    },
  ],
};

test("economics collection ranks by validator_count desc (#1313)", () => {
  const url = new URL(
    "https://x/api/v1/economics?sort=validator_count&order=desc",
  );
  const { data } = applyQueryFilters(blob, url, "economics", []) as Row;
  assert.deepEqual(
    data.subnets.map((s: Row) => s.netuid),
    [3, 1, 2],
  );
});

test("economics collection filters by registration_allowed (boolean as string)", () => {
  const url = new URL("https://x/api/v1/economics?registration_allowed=true");
  const { data } = applyQueryFilters(blob, url, "economics", []) as Row;
  assert.deepEqual(data.subnets.map((s: Row) => s.netuid).sort(), [1, 3]);
});

test("economics collection sorts by alpha_market_cap_tao with nulls last", () => {
  const url = new URL(
    "https://x/api/v1/economics?sort=alpha_market_cap_tao&order=desc",
  );
  const { data } = applyQueryFilters(blob, url, "economics", []) as Row;
  assert.deepEqual(
    data.subnets.map((s: Row) => s.netuid),
    [3, 1, 2],
  );
});

test("economics collection searches by name", () => {
  const url = new URL("https://x/api/v1/economics?q=gamma");
  const { data } = applyQueryFilters(blob, url, "economics", []) as Row;
  assert.deepEqual(
    data.subnets.map((s: Row) => s.netuid),
    [3],
  );
});

test("economics collection passes the blob through unchanged with no query", () => {
  const url = new URL("https://x/api/v1/economics");
  const { data } = applyQueryFilters(blob, url, "economics", []) as Row;
  assert.equal(data.subnets.length, 3);
});

const blockSortBlob = {
  subnets: [
    { netuid: 1, name: "alpha", block: 500, validator_count: 10 },
    { netuid: 2, name: "beta", validator_count: 20 },
    { netuid: 3, name: "gamma", block: 100, validator_count: 30 },
    { netuid: 4, name: "delta", block: null, validator_count: 40 },
  ],
};

test("economics collection sorts by block asc with missing rows last (#2576)", () => {
  const { data } = applyQueryFilters(
    blockSortBlob,
    new URL("https://x/api/v1/economics?sort=block&order=asc"),
    "economics",
    [],
  ) as Row;
  assert.deepEqual(
    data.subnets.map((s: Row) => s.netuid),
    [3, 1, 2, 4],
  );
});

test("economics collection sorts by block desc with missing rows last (#2576)", () => {
  const { data } = applyQueryFilters(
    blockSortBlob,
    new URL("https://x/api/v1/economics?sort=block&order=desc"),
    "economics",
    [],
  ) as Row;
  assert.deepEqual(
    data.subnets.map((s: Row) => s.netuid),
    [1, 3, 2, 4],
  );
});
