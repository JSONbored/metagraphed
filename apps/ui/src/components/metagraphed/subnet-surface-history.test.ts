// The surface audit trail (#10300).
//
// "12 changes" and "12 surfaces changed" are DIFFERENT claims, and the route
// publishes both counts precisely so a reader is not left to assume they are
// the same. One surface edited twelve times must never read as twelve surfaces.
import { describe, expect, it } from "vitest";
import { distinctSurfaces } from "./subnet-surface-history";
import type { SubnetSurfaceChange } from "@/lib/metagraphed/types";

const change = (surfaceId: string, action = "update"): SubnetSurfaceChange => ({
  surface_id: surfaceId,
  action,
  kind: "example",
  url: null,
  name: null,
  source_commit: "c7d264b4fa93d414ff9dfc54c9989af816736cd1",
  recorded_at: "2026-08-02T03:53:22.000Z",
});

describe("distinct surfaces in a change list", () => {
  it("one surface changed repeatedly is ONE surface", () => {
    const changes = [change("sn-64-a"), change("sn-64-a", "create"), change("sn-64-a", "remove")];
    expect(changes.length).toBe(3);
    expect(distinctSurfaces(changes)).toBe(1);
  });

  it("counts each distinct surface once", () => {
    expect(distinctSurfaces([change("sn-64-a"), change("sn-64-b"), change("sn-64-a")])).toBe(2);
  });

  it("an empty trail is zero", () => {
    expect(distinctSurfaces([])).toBe(0);
  });
});
