import { describe, expect, it } from "vitest";
import { resolveProviderCard } from "./provider-card-fields";
import type { Provider } from "./types";

const base: Provider = { slug: "acme" };

describe("resolveProviderCard", () => {
  it("uses the provider name and kind when present", () => {
    const f = resolveProviderCard(
      { ...base, name: "Acme Labs", kind: "infra" },
      { subnets: 3, surfaces: 12, endpoints: 40 },
    );
    expect(f.name).toBe("Acme Labs");
    expect(f.kindLabel).toBe("infra");
    expect(f.subnetsLabel).toBe("3");
    expect(f.surfacesLabel).toBe("12");
    expect(f.endpointsLabel).toBe("40");
  });

  it("falls back to the slug for the name and a generic kind label", () => {
    const f = resolveProviderCard(base, { subnets: 1, surfaces: 1, endpoints: 1 });
    expect(f.name).toBe("acme");
    expect(f.kindLabel).toBe("provider");
  });

  it("defaults every count to 0 when counts are missing", () => {
    const f = resolveProviderCard({ ...base, name: "Acme", kind: "team" });
    expect(f.subnetsLabel).toBe("0");
    expect(f.surfacesLabel).toBe("0");
    expect(f.endpointsLabel).toBe("0");
  });

  it("formats large counts with thousands separators", () => {
    const f = resolveProviderCard(base, { subnets: 0, surfaces: 1234, endpoints: 56789 });
    expect(f.surfacesLabel).toBe("1,234");
    expect(f.endpointsLabel).toBe("56,789");
  });
});
