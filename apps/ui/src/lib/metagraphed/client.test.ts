import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApiBase, setNetwork } from "./config";
import { ApiError, apiFetch, applyNetworkPrefix, buildUrl } from "./client";

describe("applyNetworkPrefix", () => {
  beforeEach(() => {
    setNetwork("mainnet");
  });

  it("leaves mainnet paths unchanged when the prefix is empty", () => {
    expect(applyNetworkPrefix("/api/v1/subnets")).toBe("/api/v1/subnets");
    expect(applyNetworkPrefix("/metagraph/subnets.json")).toBe("/metagraph/subnets.json");
  });

  it("inserts the testnet prefix after /api/v1 and /metagraph roots", () => {
    setNetwork("testnet");
    expect(applyNetworkPrefix("/api/v1")).toBe("/api/v1/testnet");
    expect(applyNetworkPrefix("/api/v1/subnets")).toBe("/api/v1/testnet/subnets");
    expect(applyNetworkPrefix("/metagraph/validators.json")).toBe(
      "/metagraph/testnet/validators.json",
    );
  });

  it("does not rewrite paths outside the API roots", () => {
    setNetwork("testnet");
    expect(applyNetworkPrefix("/health")).toBe("/health");
  });
});

describe("buildUrl", () => {
  beforeEach(() => {
    setApiBase("https://api.metagraph.sh");
    setNetwork("mainnet");
  });

  it("joins the API base with a normalized path", () => {
    expect(buildUrl("api/v1/subnets")).toBe("https://api.metagraph.sh/api/v1/subnets");
    expect(buildUrl("/api/v1/subnets")).toBe("https://api.metagraph.sh/api/v1/subnets");
  });

  it("applies the selected network prefix before serializing query params", () => {
    setNetwork("testnet");
    expect(buildUrl("/api/v1/validators", { sort: "uid_count", limit: 5 })).toBe(
      "https://api.metagraph.sh/api/v1/testnet/validators?sort=uid_count&limit=5",
    );
  });

  it("skips nullish and empty query values and appends array params", () => {
    const url = buildUrl("/api/v1/subnets", {
      q: "",
      limit: 20,
      netuid: null,
      sort: undefined,
      board: ["healthiest", "", "fastest-rpc"],
    });
    expect(url).toBe(
      "https://api.metagraph.sh/api/v1/subnets?limit=20&board=healthiest&board=fastest-rpc",
    );
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    setApiBase("https://api.metagraph.sh");
    setNetwork("mainnet");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps a successful JSON envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          data: { subnets: [] },
          meta: { captured_at: "2026-01-01T00:00:00Z" },
        }),
      ),
    );

    const result = await apiFetch<{ subnets: unknown[] }>("/api/v1/subnets");
    expect(result.data).toEqual({ subnets: [] });
    expect(result.meta).toEqual({ captured_at: "2026-01-01T00:00:00Z" });
    expect(result.url).toBe("https://api.metagraph.sh/api/v1/subnets");
  });

  it("treats plain JSON bodies as data when no envelope is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ subnets: [{ netuid: 1 }] })),
    );

    const result = await apiFetch<{ subnets: Array<{ netuid: number }> }>("/api/v1/subnets");
    expect(result.data).toEqual({ subnets: [{ netuid: 1 }] });
    expect(result.meta).toEqual({});
  });

  it("throws ApiError for HTTP failures with envelope messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, error: { message: "sort not supported", code: "bad_sort" } },
          { status: 400 },
        ),
      ),
    );

    await expect(apiFetch("/api/v1/validators")).rejects.toMatchObject({
      name: "ApiError",
      message: "sort not supported",
      status: 400,
      code: "bad_sort",
      url: "https://api.metagraph.sh/api/v1/validators",
    } satisfies Partial<ApiError>);
  });

  it("carries meta.network on ApiError for a network-partition 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            error: {
              message: "/api/v1/validators is only available on mainnet, not the testnet network.",
              code: "not_found",
            },
            meta: { network: "testnet" },
          },
          { status: 404 },
        ),
      ),
    );

    await expect(apiFetch("/api/v1/testnet/validators")).rejects.toMatchObject({
      code: "not_found",
      network: "testnet",
    } satisfies Partial<ApiError>);
  });

  it("throws ApiError when the envelope reports ok:false on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: false, error: { message: "partition unavailable", code: "cold" } }),
      ),
    );

    await expect(apiFetch("/api/v1/subnets")).rejects.toMatchObject({
      message: "partition unavailable",
      code: "cold",
      status: 200,
    });
  });

  it("wraps network failures as ApiError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );

    await expect(apiFetch("/api/v1/subnets")).rejects.toMatchObject({
      message: "Failed to fetch",
      status: 0,
    });
  });
});
