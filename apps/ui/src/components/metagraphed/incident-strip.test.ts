import { describe, expect, it } from "vitest";

import { isMajorOutage } from "./incident-strip";
import type { EndpointIncident } from "@/lib/metagraphed/types";

// The site-wide banner is reserved for a proxied Bittensor RPC/WSS node fully
// down, not the much larger stream of individual subnets' own dashboards/APIs
// failing their content probes (data-quality drift, not a network event).
const incident = (overrides: Partial<EndpointIncident> = {}): EndpointIncident => ({
  id: "incident-1",
  layer: "bittensor-base",
  severity: "critical",
  ...overrides,
});

describe("isMajorOutage", () => {
  it("is true for a critical, unresolved bittensor-base incident", () => {
    expect(isMajorOutage(incident())).toBe(true);
  });

  it("is false once the incident has ended", () => {
    expect(isMajorOutage(incident({ ended_at: "2026-07-22T00:00:00Z" }))).toBe(false);
  });

  it("is false for a subnet's own app/API layer, even at critical severity", () => {
    expect(isMajorOutage(incident({ layer: "subnet-app" }))).toBe(false);
    expect(isMajorOutage(incident({ layer: "data-provider" }))).toBe(false);
  });

  it("is false for a warning/degraded bittensor-base blip", () => {
    expect(isMajorOutage(incident({ severity: "warning" }))).toBe(false);
  });
});
