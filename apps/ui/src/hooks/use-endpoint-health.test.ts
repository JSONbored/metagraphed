import { describe, expect, it } from "vitest";

import { classifyEndpointLatency } from "./use-endpoint-health";

describe("classifyEndpointLatency", () => {
  it("returns down when latency is unavailable", () => {
    expect(classifyEndpointLatency(null)).toBe("down");
  });

  it("returns ok at or below the slow threshold", () => {
    expect(classifyEndpointLatency(0)).toBe("ok");
    expect(classifyEndpointLatency(300)).toBe("ok");
  });

  it("returns slow above the slow threshold through the bad threshold", () => {
    expect(classifyEndpointLatency(301)).toBe("slow");
    expect(classifyEndpointLatency(800)).toBe("slow");
  });

  it("returns bad above the bad threshold", () => {
    expect(classifyEndpointLatency(801)).toBe("bad");
    expect(classifyEndpointLatency(5000)).toBe("bad");
  });
});
