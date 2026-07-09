import { describe, expect, it } from "vitest";
import { rpcEndpointsSummaryLine } from "./rpc-endpoints-summary";

describe("rpcEndpointsSummaryLine", () => {
  it("returns null when there's no summary", () => {
    expect(rpcEndpointsSummaryLine(null)).toBeNull();
  });

  it("builds the count · archive-capable · by-status line, status parts sorted by count descending", () => {
    expect(
      rpcEndpointsSummaryLine({
        endpoint_count: 9,
        archive_supported_count: 4,
        by_status: { unknown: 1, ok: 4, degraded: 4 },
      }),
    ).toBe("9 endpoints tracked · 4 archive-capable · 4 ok · 4 degraded · 1 unknown");
  });

  it("stays singular at exactly 1 endpoint", () => {
    expect(rpcEndpointsSummaryLine({ endpoint_count: 1 })).toBe("1 endpoint tracked");
  });

  it("omits the archive-capable segment when the field is absent, and the status segment when by_status is empty", () => {
    expect(rpcEndpointsSummaryLine({ endpoint_count: 3 })).toBe("3 endpoints tracked");
    expect(rpcEndpointsSummaryLine({ endpoint_count: 3, by_status: {} })).toBe(
      "3 endpoints tracked",
    );
  });

  it("defaults a missing endpoint_count to 0", () => {
    expect(rpcEndpointsSummaryLine({})).toBe("0 endpoints tracked");
  });
});
