import { describe, expect, it } from "vitest";

import { resolveEndpointCard } from "./endpoint-card-fields";
import type { Endpoint, Provider, Subnet } from "@/lib/metagraphed/types";

const PROVIDERS = new Map<string, Provider>([
  ["acme", { slug: "acme", name: "Acme Labs" } as Provider],
]);
const SUBNETS = new Map<number, Subnet>([[21, { netuid: 21, name: "AdTAO" } as Subnet]]);

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { id: "ep-1", ...overrides };
}

describe("resolveEndpointCard", () => {
  it("resolves the provider and subnet from the lookup maps", () => {
    const fields = resolveEndpointCard(
      endpoint({ netuid: 21, provider_slug: "acme", kind: "api" }),
      PROVIDERS,
      SUBNETS,
    );
    expect(fields.provSlug).toBe("acme");
    expect(fields.prov?.name).toBe("Acme Labs");
    expect(fields.sn?.name).toBe("AdTAO");
    expect(fields.netuidLabel).toBe("021");
    expect(fields.kindLabel).toBe("api");
  });

  it("zero-pads the netuid label to three digits", () => {
    expect(resolveEndpointCard(endpoint({ netuid: 5 }), PROVIDERS, SUBNETS).netuidLabel).toBe(
      "005",
    );
    expect(resolveEndpointCard(endpoint({ netuid: 118 }), PROVIDERS, SUBNETS).netuidLabel).toBe(
      "118",
    );
  });

  it("returns a null netuid label and no subnet when the row has no netuid", () => {
    const fields = resolveEndpointCard(endpoint({ provider_slug: "acme" }), PROVIDERS, SUBNETS);
    expect(fields.netuidLabel).toBeNull();
    expect(fields.sn).toBeUndefined();
  });

  it("leaves the provider undefined when the slug is missing or unknown", () => {
    expect(resolveEndpointCard(endpoint({}), PROVIDERS, SUBNETS).prov).toBeUndefined();
    expect(
      resolveEndpointCard(endpoint({ provider_slug: "ghost" }), PROVIDERS, SUBNETS).prov,
    ).toBeUndefined();
  });

  it("falls back to a generic kind label when kind is absent", () => {
    expect(resolveEndpointCard(endpoint({}), PROVIDERS, SUBNETS).kindLabel).toBe("endpoint");
  });
});
