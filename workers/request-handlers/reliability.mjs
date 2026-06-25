// GET /api/v1/subnets/{netuid}/reliability — composite reliability scorecard.
// Extracted from workers/api.mjs (#1763-style de-monolith) so the route shares
// the same analytics envelope + edge-cache posture as /uptime without duplicating
// the per-day uptime series payload.

import { RELIABILITY_WINDOWS } from "../config.mjs";
import { loadReliabilityScorecard } from "../../src/health-serving.mjs";
import {
  analyticsMeta,
  analyticsQueryError,
  d1Runner,
  validateQueryParams,
} from "./analytics.mjs";
import { envelopeResponse } from "../responses.mjs";
import { errorResponse } from "../http.mjs";

let readHealthMetaKv = async () => null;

export function configureReliability({ readHealthMetaKv: reader }) {
  readHealthMetaKv = reader;
}

function validateReliabilityNetuid(netuid) {
  if (!Number.isInteger(netuid) || netuid < 0) {
    return errorResponse(
      "invalid_path",
      "Path parameter `netuid` must be a non-negative integer.",
      400,
      { parameter: "netuid" },
    );
  }
  return null;
}

function reliabilityWindowHelp() {
  return RELIABILITY_WINDOWS;
}

export async function handleSubnetReliability(
  request,
  env,
  netuid,
  url,
  { maxRows = 5000 } = {},
) {
  const netuidError = validateReliabilityNetuid(netuid);
  if (netuidError) return netuidError;
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const windowParam = url.searchParams.get("window") || "30d";
  if (!Object.hasOwn(reliabilityWindowHelp(), windowParam)) {
    return errorResponse(
      "invalid_query",
      "Query parameter `window` must be one of: 7d, 30d, 90d.",
      400,
      { parameter: "window" },
    );
  }
  const healthMeta = await readHealthMetaKv(env);
  const data = await loadReliabilityScorecard({
    d1: d1Runner(env),
    netuid,
    windowDays: RELIABILITY_WINDOWS[windowParam],
    observedAt: healthMeta?.last_run_at || null,
    now: new Date().toISOString(),
    limit: maxRows,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await analyticsMeta(
        env,
        `/metagraph/subnets/${netuid}/reliability.json`,
        data.observed_at,
      ),
    },
    "short",
  );
}
