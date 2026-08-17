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

// #8700's network-scoping property MOVED rather than disappeared. The dot no
// longer builds a URL at all -- every sample now comes from `apiFetch`, which
// resolves the network at call time -- so the assertion lives beside the code
// that owns it, in lib/metagraphed/api-latency.test.ts.
