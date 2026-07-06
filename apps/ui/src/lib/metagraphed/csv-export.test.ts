import { describe, expect, it, vi } from "vitest";

import { buildCsvExportUrl, triggerCsvDownload } from "./csv-export";

describe("buildCsvExportUrl", () => {
  it("appends format=csv to a path with no query string", () => {
    expect(buildCsvExportUrl("/api/v1/blocks")).toBe("/api/v1/blocks?format=csv");
  });

  it("preserves existing filters and adds format=csv", () => {
    expect(buildCsvExportUrl("/api/v1/subnets?limit=25&sort=netuid")).toBe(
      "/api/v1/subnets?limit=25&sort=netuid&format=csv",
    );
  });

  it("overwrites an existing format param with csv", () => {
    expect(buildCsvExportUrl("/api/v1/extrinsics?format=json&limit=50")).toBe(
      "/api/v1/extrinsics?format=csv&limit=50",
    );
  });

  it("keeps absolute URLs absolute", () => {
    expect(buildCsvExportUrl("https://api.metagraph.sh/api/v1/blocks?limit=10")).toBe(
      "https://api.metagraph.sh/api/v1/blocks?limit=10&format=csv",
    );
  });

  it("preserves URL fragments", () => {
    expect(buildCsvExportUrl("/api/v1/blocks?limit=10#tail")).toBe(
      "/api/v1/blocks?limit=10&format=csv#tail",
    );
  });
});

describe("triggerCsvDownload", () => {
  it("opens a new tab via a transient anchor with optional download hint", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = {
      href: "",
      target: "",
      rel: "",
      download: "",
      style: { display: "" },
      click,
      remove,
    } as unknown as HTMLAnchorElement;
    const body = { appendChild: vi.fn(() => anchor) };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body,
    });

    triggerCsvDownload("/api/v1/blocks?limit=5", "https://metagraph.sh", "blocks.csv");

    expect(document.createElement).toHaveBeenCalledWith("a");
    expect(anchor.href).toBe("/api/v1/blocks?limit=5&format=csv");
    expect(anchor.target).toBe("_blank");
    expect(anchor.rel).toBe("noopener noreferrer");
    expect(anchor.download).toBe("blocks.csv");
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
