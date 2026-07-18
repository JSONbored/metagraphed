import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildDomainSummary,
  buildDomainOverview,
} from "../src/domain-summary.mjs";
import { DOMAIN_TAGS } from "../src/domain-tags.mjs";

const SUBNETS = [
  { netuid: 1, categories: ["inference"], derived_categories: [] },
  { netuid: 2, categories: [], derived_categories: ["inference", "agents"] },
  { netuid: 3, categories: ["finance"], derived_categories: [] },
  { netuid: 4, categories: [], derived_categories: [] }, // no domain tags at all
];

const ECONOMICS = [
  { netuid: 1, total_stake_tao: 100, emission_share: 0.4 },
  { netuid: 2, total_stake_tao: 50, emission_share: 0.1 },
  { netuid: 3, total_stake_tao: 25, emission_share: 0.2 },
  // netuid 4 has no economics row at all -- cold/missing tier.
];

describe("buildDomainSummary", () => {
  test("membership is the union of categories and derived_categories, matching ?domain=", () => {
    const inference = buildDomainSummary("inference", SUBNETS, ECONOMICS);
    assert.deepEqual(inference.netuids, [1, 2]);
    assert.equal(inference.subnet_count, 2);
  });

  test("a subnet carrying the tag only via derived_categories still counts", () => {
    const agents = buildDomainSummary("agents", SUBNETS, ECONOMICS);
    assert.deepEqual(agents.netuids, [2]);
  });

  test("sums total_stake_tao and total_emission_share across the domain's members", () => {
    const inference = buildDomainSummary("inference", SUBNETS, ECONOMICS);
    assert.equal(inference.total_stake_tao, 150); // 100 + 50
    assert.equal(inference.total_emission_share, 0.5); // 0.4 + 0.1
  });

  test("emission_concentration is computeConcentration over the domain's own emission shares", () => {
    // Two members (0.4, 0.1): matches computeConcentration([0.4, 0.1]) directly.
    const inference = buildDomainSummary("inference", SUBNETS, ECONOMICS);
    assert.ok(inference.emission_concentration);
    assert.equal(inference.emission_concentration.holders, 2);
    // A single-member domain (finance: only netuid 3) is maximally concentrated.
    const finance = buildDomainSummary("finance", SUBNETS, ECONOMICS);
    assert.equal(finance.emission_concentration.holders, 1);
    assert.equal(finance.emission_concentration.gini, 0);
    assert.equal(finance.emission_concentration.hhi, 1);
  });

  test("a tag with zero member subnets returns a schema-stable empty rollup", () => {
    const security = buildDomainSummary("security", SUBNETS, ECONOMICS);
    assert.equal(security.domain, "security");
    assert.equal(security.subnet_count, 0);
    assert.deepEqual(security.netuids, []);
    assert.equal(security.total_stake_tao, 0);
    assert.equal(security.total_emission_share, 0);
    assert.equal(security.emission_concentration, null);
  });

  test("a member subnet missing an economics row still counts toward subnet_count/netuids", () => {
    // netuid 4 carries no domain tags in the fixture -- verify separately with
    // its own tag so the "missing economics, present in membership" path is
    // exercised without polluting the other assertions above.
    const noEconomics = [
      { netuid: 5, categories: ["robotics"], derived_categories: [] },
    ];
    const robotics = buildDomainSummary("robotics", noEconomics, []);
    assert.equal(robotics.subnet_count, 1);
    assert.deepEqual(robotics.netuids, [5]);
    assert.equal(robotics.total_stake_tao, 0);
    assert.equal(robotics.total_emission_share, 0);
    assert.equal(robotics.emission_concentration, null);
  });

  test("non-array / empty subnetRows and economicsRows never throw", () => {
    assert.equal(buildDomainSummary("inference", [], []).subnet_count, 0);
    assert.equal(
      buildDomainSummary("inference", null, undefined).subnet_count,
      0,
    );
  });

  test("a subnetRows entry with a non-integer netuid is skipped, not thrown on", () => {
    const junk = [{ netuid: "not-a-number", categories: ["inference"] }];
    assert.equal(buildDomainSummary("inference", junk, []).subnet_count, 0);
  });

  test("a subnet missing categories/derived_categories entirely (not just empty) never throws", () => {
    const legacy = [{ netuid: 6 }]; // no categories/derived_categories keys at all
    assert.equal(buildDomainSummary("inference", legacy, []).subnet_count, 0);
  });

  test("an economicsRows entry with a non-integer netuid is ignored, not joined", () => {
    const subnets = [
      { netuid: 7, categories: ["search"], derived_categories: [] },
    ];
    const badEconomics = [
      { netuid: "not-a-number", total_stake_tao: 100, emission_share: 0.5 },
    ];
    const search = buildDomainSummary("search", subnets, badEconomics);
    assert.equal(search.subnet_count, 1);
    assert.equal(search.total_stake_tao, 0);
    assert.equal(search.total_emission_share, 0);
  });

  test("a non-finite economics total_stake_tao/emission_share doesn't contribute to the total", () => {
    const subnets = [
      { netuid: 9, categories: ["storage"], derived_categories: [] },
    ];
    const economics = [
      { netuid: 9, total_stake_tao: "not-a-number", emission_share: null },
    ];
    const storage = buildDomainSummary("storage", subnets, economics);
    assert.equal(storage.subnet_count, 1);
    assert.equal(storage.total_stake_tao, 0);
    assert.equal(storage.total_emission_share, 0);
  });
});

describe("buildDomainOverview", () => {
  test("returns one entry per domain tag in the fixed taxonomy", () => {
    const overview = buildDomainOverview(SUBNETS, ECONOMICS);
    assert.equal(overview.domain_count, DOMAIN_TAGS.length);
    assert.equal(overview.domains.length, DOMAIN_TAGS.length);
    assert.deepEqual(
      overview.domains.map((d) => d.domain).sort(),
      [...DOMAIN_TAGS].sort(),
    );
  });

  test("each overview entry matches buildDomainSummary's own output for that tag", () => {
    const overview = buildDomainOverview(SUBNETS, ECONOMICS);
    const inference = overview.domains.find((d) => d.domain === "inference");
    assert.deepEqual(
      inference,
      buildDomainSummary("inference", SUBNETS, ECONOMICS),
    );
  });
});
