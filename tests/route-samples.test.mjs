import { describe, expect, it } from "vitest";
import {
  DOCS_SAMPLE_DATE,
  SAMPLE_SS58,
  buildSampleRouteUrl,
  sampleQueryParams,
  substituteRoutePlaceholders,
} from "../scripts/lib/route-samples.mjs";
import { apiRouteUrl } from "../scripts/smoke-live-api.mjs";

describe("route-samples", () => {
  it("substitutes canonical sample ids for API placeholders", () => {
    expect(substituteRoutePlaceholders("/api/v1/accounts/{ss58}")).toBe(
      `/api/v1/accounts/${SAMPLE_SS58}`,
    );
    expect(substituteRoutePlaceholders("/api/v1/subnets/{netuid}")).toBe(
      "/api/v1/subnets/7",
    );
  });

  it("buildSampleRouteUrl matches smoke-live-api apiRouteUrl", () => {
    const routePath = "/api/v1/compare";
    expect(buildSampleRouteUrl(routePath, "https://api.metagraph.sh")).toBe(
      apiRouteUrl(routePath, DOCS_SAMPLE_DATE),
    );
    expect(sampleQueryParams(routePath)).toEqual({ netuids: "7,8" });
  });
});
