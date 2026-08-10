// The Query-binding registry is now the SOURCE of the published field's return
// type and description (#10214), so the gate that keeps it honest has to be
// able to fail on each of them.
//
// Every test here mutates one side and asserts the mismatch is reported. The
// gate's own run against the real tree only ever proves it passes.
import { describe, expect, it } from "vitest";
import {
  compareQueryBindings,
  type SdlBinding,
} from "../scripts/validate-published-names.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";

const sdl: SdlBinding[] = [
  {
    field: "subnets",
    route: null,
    returns: "SubnetList!",
    description: "Paginated active-subnet index.",
  },
  {
    field: "subnet_registrations",
    route: "/api/v1/subnets/{netuid}/registrations",
    returns: "SubnetRegistrations!",
    description: "Per-subnet registration activity.",
  },
];
const registry = sdl.map((binding) => ({ ...binding }));

describe("compareQueryBindings", () => {
  it("says nothing when the two agree", () => {
    expect(compareQueryBindings(sdl, registry)).toEqual([]);
  });

  it("FAILS when only the nullability differs", () => {
    // The check that reading bare type names could not make: `SubnetList` and
    // `SubnetList!` are different promises, and the generator emits whichever
    // the registry holds.
    const drifted = registry.map((b) =>
      b.field === "subnets" ? { ...b, returns: "SubnetList" } : b,
    );
    expect(compareQueryBindings(sdl, drifted)).toEqual([
      "subnets returns SubnetList!, the registry says SubnetList",
    ]);
  });

  it("FAILS when the description differs", () => {
    const drifted = registry.map((b) =>
      b.field === "subnets" ? { ...b, description: "Something else." } : b,
    );
    expect(compareQueryBindings(sdl, drifted)).toEqual([
      "subnets -- the SDL's description and the registry's differ",
    ]);
  });

  it("FAILS on a description that differs only in whitespace", () => {
    const drifted = registry.map((b) =>
      b.field === "subnets" ? { ...b, description: `${b.description} ` } : b,
    );
    expect(compareQueryBindings(sdl, drifted)).toHaveLength(1);
  });

  it("FAILS when the mirrored route differs", () => {
    const drifted = registry.map((b) =>
      b.field === "subnet_registrations" ? { ...b, route: "/api/v1/other" } : b,
    );
    expect(compareQueryBindings(sdl, drifted)).toEqual([
      "subnet_registrations mirrors /api/v1/subnets/{netuid}/registrations, the registry says /api/v1/other",
    ]);
  });

  it("FAILS in BOTH directions on a field only one side has", () => {
    expect(compareQueryBindings(sdl, [registry[0]])).toEqual([
      "subnet_registrations -- in the SDL, not in QUERY_BINDINGS",
    ]);
    expect(compareQueryBindings([sdl[0]], registry)).toEqual([
      "subnet_registrations -- in QUERY_BINDINGS, not in the SDL",
    ]);
  });

  it("reports every drifted field, not just the first", () => {
    const drifted = registry.map((b) => ({ ...b, description: "x" }));
    expect(compareQueryBindings(sdl, drifted)).toHaveLength(2);
  });
});

describe("the real registry", () => {
  it("declares a return type and a description for all 196 fields", () => {
    expect(QUERY_BINDINGS).toHaveLength(196);
    for (const binding of QUERY_BINDINGS) {
      expect(binding.returns, binding.field).toMatch(/^\[?\w+!?\]?!?$/);
      expect(binding.description.length, binding.field).toBeGreaterThan(0);
    }
  });

  it("carries the Mirrors GET annotation on every route-backed field", () => {
    // The annotation is not decoration: `validate-graphql-component-parity`
    // seeds its whole type/component pairing by traversing from it, so a
    // description that loses it takes a subtree of the schema out of the gate.
    for (const binding of QUERY_BINDINGS) {
      if (!binding.route) continue;
      expect(binding.description, binding.field).toContain(
        `Mirrors GET ${binding.route}`,
      );
    }
  });
});
