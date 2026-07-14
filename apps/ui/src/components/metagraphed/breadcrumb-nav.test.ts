import { describe, expect, it } from "vitest";
import { buildCrumbs, parentCrumb } from "./breadcrumb-nav";

describe("buildCrumbs", () => {
  it("returns just the registry root on the home page", () => {
    expect(buildCrumbs("/")).toEqual([{ label: "Registry", to: "/" }]);
  });

  it("builds one crumb per path segment", () => {
    expect(buildCrumbs("/validators")).toEqual([
      { label: "Registry", to: "/" },
      { label: "validators", to: "/validators" },
    ]);
  });

  it("builds a full trail for a deep entity-detail route", () => {
    expect(buildCrumbs("/validators/5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX")).toEqual([
      { label: "Registry", to: "/" },
      { label: "validators", to: "/validators" },
      {
        label: "5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX",
        to: "/validators/5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX",
      },
    ]);
  });

  it("decodes URL-encoded path segments", () => {
    expect(buildCrumbs("/subnets/SN%2043")).toEqual([
      { label: "Registry", to: "/" },
      { label: "subnets", to: "/subnets" },
      { label: "SN 43", to: "/subnets/SN%2043" },
    ]);
  });
});

describe("parentCrumb", () => {
  it("is null on the root page (nothing to go back to)", () => {
    expect(parentCrumb(buildCrumbs("/"))).toBeNull();
  });

  it("resolves the section index for a one-level page", () => {
    expect(parentCrumb(buildCrumbs("/validators"))).toEqual({ label: "Registry", to: "/" });
  });

  it("resolves the section index for a deep entity-detail route", () => {
    expect(parentCrumb(buildCrumbs("/validators/5abc"))).toEqual({
      label: "validators",
      to: "/validators",
    });
  });

  it("resolves one level up regardless of depth", () => {
    expect(parentCrumb(buildCrumbs("/subnets/43/history"))).toEqual({
      label: "43",
      to: "/subnets/43",
    });
  });
});
