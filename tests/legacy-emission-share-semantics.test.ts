import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { buildEconomicsArtifact } from "../scripts/lib/economics-artifacts.ts";
import { API_ROUTES, PUBLIC_ARTIFACTS } from "../src/contracts.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { reconstructEmissionPipeline } from "../src/emission-pipeline.ts";
import { GRAPHQL_EXPOSURES } from "../schemas-src/graphql/query-exposures.ts";
import {
  LEGACY_EMISSION_SHARE_DESCRIPTION,
  PIPELINE_EMISSION_SHARE_DESCRIPTION,
} from "../schemas-src/legacy-emission-share.ts";
import { SubnetEconomicsSchema } from "../schemas-src/shared.ts";
import { CompareArtifactSchema } from "../schemas-src/routes/compare.ts";
import { DomainsArtifactSchema } from "../schemas-src/routes/domains.ts";
import { EconomicsTrendsArtifactSchema } from "../schemas-src/routes/economics-trends.ts";
import { PipelineHistoryPointSchema } from "../schemas-src/routes/emission-pipeline-history.ts";
import { SubnetEmissionDecompositionSchema } from "../schemas-src/routes/emission-pipeline.ts";
import { RegistryLeaderboardsArtifactSchema } from "../schemas-src/routes/registry-summary-leaderboards.ts";
import { SubnetTrajectoryArtifactSchema } from "../schemas-src/routes/subnet-trajectory.ts";
import { FindSubnetOpportunitiesOutputSchema } from "../schemas-src/mcp-tools/ai-discovery.ts";
import { GetDomainSummaryOutputSchema } from "../schemas-src/mcp-tools/get-domain-summary.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Inspect emitted field metadata, including fields nested in arrays/definitions. */
function shareDescriptions(value: unknown): string[] {
  const object = record(value);
  if (!object)
    return Array.isArray(value) ? value.flatMap(shareDescriptions) : [];
  const descriptions: string[] = [];
  for (const [name, field] of Object.entries(record(object.properties) ?? {})) {
    if (
      ![
        "emission_share",
        "mean_emission_share",
        "total_emission_share",
      ].includes(name)
    ) {
      continue;
    }
    const description = record(field)?.description;
    assert.equal(typeof description, "string", `${name} needs provenance`);
    descriptions.push(description as string);
  }
  return descriptions.concat(Object.values(object).flatMap(shareDescriptions));
}

function assertLegacy(description: string | undefined): void {
  assert.ok(description?.includes(LEGACY_EMISSION_SHARE_DESCRIPTION));
}

describe("legacy emission-share provenance (#11552)", () => {
  test("preserves priced Root and runtime-ineligible rows in the legacy denominator", () => {
    const subnets = [0, 1, 2].map((netuid) => ({
      netuid,
      slug: `sn-${netuid}`,
      name: `Subnet ${netuid}`,
    }));
    const artifact = buildEconomicsArtifact({
      subnets,
      economicsByNetuid: new Map([
        [0, { alpha_price_tao: 1 }],
        [1, { alpha_price_tao: 1 }],
        [2, { alpha_price_tao: 2, subtoken_enabled: false }],
      ]),
      generatedAt: "2026-10-17T00:00:00Z",
    });
    const legacy = Object.fromEntries(
      artifact.subnets.map(
        (row: { netuid: number; emission_share: number }) => [
          row.netuid,
          row.emission_share,
        ],
      ),
    );
    assert.deepEqual(legacy, { 0: 0.25, 1: 0.25, 2: 0.5 });

    // The same prices produce a different Stage-1 distribution once eligibility
    // is known. Relabeling the legacy value would assert facts its writer lacks.
    const pipeline = reconstructEmissionPipeline({
      subnets: subnets.map(({ netuid }) => ({
        netuid,
        moving_price: netuid === 2 ? 2 : 1,
        miner_burned: 0,
        emission_enabled: true,
        first_emission_block: 1,
        subtoken_enabled: netuid !== 2,
        registration_allowed: true,
      })),
      parameters: { theta: 0.01, exponent: 3 },
    });
    assert.deepEqual(
      Object.fromEntries(
        pipeline.subnets.map((row) => [row.netuid, row.price_share]),
      ),
      { 0: null, 1: 1, 2: null },
    );
  });

  test("REST and artifact descriptions identify the legacy denominator", () => {
    for (const path of [
      "/api/v1/economics",
      "/api/v1/economics/trends",
      "/api/v1/domains",
      "/api/v1/domains/{tag}/summary",
      "/api/v1/subnets/{netuid}/emission-pipeline/history",
    ]) {
      assertLegacy(
        API_ROUTES.find((route) => route.path === path)?.description,
      );
    }
    assertLegacy(
      PUBLIC_ARTIFACTS.find((artifact) => artifact.id === "economics")
        ?.description,
    );
  });

  test("MCP and GraphQL prose keep historical normalization separate from the live pipeline", () => {
    for (const name of [
      "get_economics",
      "get_subnet_economics",
      "get_economics_trends",
      "get_domain_summary",
      "get_subnet_trajectory",
      "get_emission_pipeline_history",
    ]) {
      assertLegacy(MCP_TOOLS.find((tool) => tool.name === name)?.description);
    }
    for (const field of [
      "economics",
      "economics_trends",
      "domains",
      "domain_summary",
      "subnet_trajectory",
      "subnet_emission_pipeline_history",
    ]) {
      assertLegacy(
        GRAPHQL_EXPOSURES.find((exposure) => exposure.field === field)
          ?.description,
      );
    }
    const live = MCP_TOOLS.find(
      (tool) => tool.name === "get_emission_pipeline",
    )!;
    assert.match(
      live.description,
      /eligible runtime pipeline from pinned inputs/,
    );
    assert.doesNotMatch(
      live.description,
      /that field is the STAGE-1 PRICE SHARE/,
    );
  });

  test("published legacy field schemas carry provenance without changing wire types", () => {
    for (const schema of [
      SubnetEconomicsSchema,
      CompareArtifactSchema,
      DomainsArtifactSchema,
      EconomicsTrendsArtifactSchema,
      PipelineHistoryPointSchema,
      RegistryLeaderboardsArtifactSchema,
      SubnetTrajectoryArtifactSchema,
      FindSubnetOpportunitiesOutputSchema,
      GetDomainSummaryOutputSchema,
    ]) {
      const descriptions = shareDescriptions(z.toJSONSchema(schema));
      assert.ok(descriptions.length > 0);
      descriptions.forEach(assertLegacy);
    }
    // Existing optional/null/range semantics stay intact; no values are renamed.
    const legacy = SubnetEconomicsSchema.shape.emission_share;
    assert.equal(legacy.parse(undefined), undefined);
    assert.equal(legacy.parse(null), null);
    assert.equal(legacy.parse(0.25), 0.25);
    assert.equal(legacy.safeParse(1.01).success, false);
    assert.equal(
      SubnetEmissionDecompositionSchema.shape.emission_share.description,
      PIPELINE_EMISSION_SHARE_DESCRIPTION,
    );
  });
});
