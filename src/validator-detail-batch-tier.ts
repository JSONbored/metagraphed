import {
  tryDataApiTier,
  markDataApiTierFallback,
} from "../workers/data-api-tier.ts";
import { buildValidatorDetail, NO_ALPHA_PRICES } from "./metagraph-neurons.ts";

/** One existing service owner supplies the details shared by REST and MCP.
 * During a mixed runtime rollout or a failed batch, retain the bounded old
 * per-key fallback so one bad member cannot erase the other comparisons. */
export async function loadValidatorDetailBatchTier(
  env: Env,
  hotkeys: readonly string[],
  origin = "https://data-api.internal",
): Promise<ReturnType<typeof buildValidatorDetail>[]> {
  const url = new URL("/api/v1/internal/validator-details", origin);
  url.searchParams.set("hotkeys", hotkeys.join(","));
  const batch = await tryDataApiTier(
    env,
    new Request(url),
    "METAGRAPH_NEURONS_SOURCE",
  );
  if (
    Array.isArray(batch?.details) &&
    batch.details.length === hotkeys.length &&
    batch.details.every(
      (detail, index) =>
        detail &&
        typeof detail === "object" &&
        detail.hotkey === hotkeys[index] &&
        detail.schema_version === 2,
    )
  )
    return batch.details as ReturnType<typeof buildValidatorDetail>[];
  if (batch) markDataApiTierFallback();
  const details: ReturnType<typeof buildValidatorDetail>[] = [];
  for (const hotkey of hotkeys) {
    const detail = await tryDataApiTier(
      env,
      new Request(
        new URL(`/api/v1/validators/${encodeURIComponent(hotkey)}`, origin),
      ),
      "METAGRAPH_NEURONS_SOURCE",
    );
    details.push(
      detail ??
        buildValidatorDetail([], hotkey, { priceByNetuid: NO_ALPHA_PRICES }),
    );
  }
  return details;
}
