import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCsvDownloadUrl, startCsvDownload } from "@/lib/metagraphed/client";
import { setApiBase, setNetwork } from "@/lib/metagraphed/config";

describe("buildCsvDownloadUrl", () => {
  beforeEach(() => {
    setApiBase("https://api.metagraph.sh");
    setNetwork("mainnet");
  });

  afterEach(() => {
    setApiBase("https://api.metagraph.sh");
    setNetwork("mainnet");
  });

  it("appends format=csv while preserving list query params", () => {
    const url = buildCsvDownloadUrl("/api/v1/subnets", {
      fields: "netuid,name",
      sort: "netuid",
      limit: 50,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.metagraph.sh");
    expect(parsed.pathname).toBe("/api/v1/subnets");
    expect(parsed.searchParams.get("format")).toBe("csv");
    expect(parsed.searchParams.get("fields")).toBe("netuid,name");
    expect(parsed.searchParams.get("sort")).toBe("netuid");
    expect(parsed.searchParams.get("limit")).toBe("50");
  });

  it("inserts the selected network prefix before format=csv", () => {
    setNetwork("testnet");
    const url = buildCsvDownloadUrl("/api/v1/blocks", { limit: 10 });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/testnet/blocks");
    expect(parsed.searchParams.get("format")).toBe("csv");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });
});

describe("startCsvDownload", () => {
  it("creates a temporary anchor with the CSV URL and optional filename", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = {
      href: "",
      download: "",
      rel: "",
      style: { display: "" },
      click,
      remove,
    } as unknown as HTMLAnchorElement;
    const createElement = vi.fn(() => anchor);
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      createElement,
      body: { appendChild },
    });

    startCsvDownload("https://api.metagraph.sh/api/v1/subnets?format=csv", "subnets.csv");

    expect(createElement).toHaveBeenCalledWith("a");
    expect(anchor.href).toBe("https://api.metagraph.sh/api/v1/subnets?format=csv");
    expect(anchor.download).toBe("subnets.csv");
    expect(anchor.rel).toBe("noopener");
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(appendChild).toHaveBeenCalledWith(anchor);

    vi.unstubAllGlobals();
  });
});
