import { describe, expect, it } from "vitest";
import {
  canonicalSubnetProfileDestination,
  RETIRED_SUBNET_PROFILE_TABS,
  SUBNET_PROFILE_SECTIONS,
  legacySubnetProfileDestination,
  normalizeSubnetProfileView,
} from "./subnet-profile-navigation";

describe("subnet profile navigation", () => {
  it("normalizes every retired view to an intentional dossier job", () => {
    expect(normalizeSubnetProfileView("api")).toBe("build");
    expect(normalizeSubnetProfileView("validators")).toBe("participate");
    expect(normalizeSubnetProfileView("metagraph")).toBe("records");
    expect(normalizeSubnetProfileView("economics")).toBe("research");
    expect(normalizeSubnetProfileView("services")).toBe("build");
    expect(normalizeSubnetProfileView("evidence")).toBe("records");
    expect(normalizeSubnetProfileView("not-a-real-view")).toBeUndefined();
  });

  it("keeps legacy resource hashes on a mounted, selected consolidated destination", () => {
    expect(SUBNET_PROFILE_SECTIONS.endpoints).toMatchObject({
      tab: "build",
      target: "resources",
      search: { resource: "endpoints" },
    });
    expect(SUBNET_PROFILE_SECTIONS.surfaces).toMatchObject({
      tab: "build",
      target: "resources",
      search: { resource: "surfaces" },
    });
    expect(SUBNET_PROFILE_SECTIONS.schemas).toMatchObject({
      tab: "build",
      target: "resources",
      search: { resource: "schemas" },
    });
    expect(SUBNET_PROFILE_SECTIONS["schema-drift"]).toMatchObject({
      tab: "build",
      search: { resource: "schemas" },
    });
    expect(SUBNET_PROFILE_SECTIONS["emission-pipeline"]).toMatchObject({
      tab: "research",
      target: "emission-detail",
    });
    expect(SUBNET_PROFILE_SECTIONS.concentration).toMatchObject({
      tab: "participate",
      target: "concentration",
    });
    expect(SUBNET_PROFILE_SECTIONS.watch).toMatchObject({
      tab: "records",
      target: "profile-tools-detail",
    });
  });

  it("gives every retired tab a canonical, exact modern destination", () => {
    expect(RETIRED_SUBNET_PROFILE_TABS).toHaveLength(16);
    for (const retiredTab of RETIRED_SUBNET_PROFILE_TABS) {
      const destination = legacySubnetProfileDestination(retiredTab);
      expect(destination).toBeDefined();
      expect(destination?.tab).toMatch(/^(build|research|participate|records)$/);
      expect(destination?.hash).toBeTruthy();
    }

    expect(legacySubnetProfileDestination("api")).toEqual({ tab: "build", hash: "api" });
    expect(legacySubnetProfileDestination("surfaces")).toEqual({
      tab: "build",
      hash: "resources",
      resource: "surfaces",
    });
    expect(legacySubnetProfileDestination("governance")).toEqual({
      tab: "records",
      hash: "governance-record-detail",
    });
    expect(legacySubnetProfileDestination("evidence")).toEqual({
      tab: "records",
      hash: "evidence",
    });
    expect(legacySubnetProfileDestination("build")).toBeUndefined();
  });

  it("gives an explicit fragment precedence over a retired tab and clears stale lenses", () => {
    expect(canonicalSubnetProfileDestination({ tab: "api" }, "#evidence")).toEqual({
      tab: "records",
      hash: "evidence",
      clearResource: false,
    });
    expect(canonicalSubnetProfileDestination({ tab: "surfaces" }, "")).toEqual({
      tab: "build",
      hash: "resources",
      resource: "surfaces",
      clearResource: false,
    });
    expect(
      canonicalSubnetProfileDestination(
        { tab: "surfaces", resource: "surfaces" },
        "#evidence",
      ),
    ).toEqual({
      tab: "records",
      hash: "evidence",
      clearResource: true,
    });
    expect(canonicalSubnetProfileDestination({ tab: "records" }, "#evidence")).toBeUndefined();
  });
});
