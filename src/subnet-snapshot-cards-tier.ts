import {
  tryDataApiTier,
  markDataApiTierFallback,
} from "../workers/data-api-tier.ts";
import { buildConcentration } from "./concentration.ts";
import { buildSubnetPerformance } from "./subnet-performance.ts";
import { buildSubnetValidators } from "./metagraph-neurons.ts";

type SnapshotCards = {
  concentration: ReturnType<typeof buildConcentration>;
  performance: ReturnType<typeof buildSubnetPerformance>;
  validators: ReturnType<typeof buildSubnetValidators>;
};
export async function loadSubnetSnapshotCardsTier(
  env: Env,
  netuid: number,
): Promise<SnapshotCards> {
  const request = (path: string) =>
    new Request(new URL(path, "https://data-api.internal"));
  const shared = await tryDataApiTier(
    env,
    request(`/api/v1/internal/subnets/${netuid}/snapshot-cards`),
    "METAGRAPH_NEURONS_SOURCE",
  );
  if (
    shared &&
    ["concentration", "performance", "validators"].every((key) => {
      const card = shared[key] as Record<string, unknown> | undefined;
      return card && card.netuid === netuid;
    })
  )
    return shared as SnapshotCards;
  if (shared) markDataApiTierFallback();
  const [concentration, performance, validators] = await Promise.all([
    tryDataApiTier(
      env,
      request(`/api/v1/subnets/${netuid}/concentration`),
      "METAGRAPH_NEURONS_SOURCE",
    ).then((v) => v ?? buildConcentration([], netuid)),
    tryDataApiTier(
      env,
      request(`/api/v1/subnets/${netuid}/performance`),
      "METAGRAPH_NEURONS_SOURCE",
    ).then((v) => v ?? buildSubnetPerformance([], netuid)),
    tryDataApiTier(
      env,
      request(`/api/v1/subnets/${netuid}/validators`),
      "METAGRAPH_NEURONS_SOURCE",
    ).then((v) => v ?? buildSubnetValidators([], netuid)),
  ]);
  return { concentration, performance, validators };
}
