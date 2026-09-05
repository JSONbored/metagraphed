import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./client";
import { agentCatalogMapQuery, subnetHealthMapQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const fetch = vi.mocked(apiFetch);
beforeEach(() => {
  fetch.mockReset();
});

describe("subnet directory secondary reads", () => {
  for (const [name, query, payload] of [
    ["health", subnetHealthMapQuery, { subnets: [{ netuid: 0, status: "degraded" }] }],
    [
      "API specs",
      agentCatalogMapQuery,
      { subnets: [{ netuid: 0, service_kinds: ["openapi"] }], blocked_subnets: [] },
    ],
  ] as const) {
    const read = (client: QueryClient) =>
      name === "health"
        ? client.fetchQuery({ ...subnetHealthMapQuery(), staleTime: 0 })
        : client.fetchQuery({ ...agentCatalogMapQuery(), staleTime: 0 });
    it(`${name} failures reject instead of becoming an empty success`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const failure = new Error("source unavailable");
      fetch.mockRejectedValue(failure);
      await expect(read(client)).rejects.toBe(failure);
      expect(client.getQueryState(query().queryKey)?.status).toBe("error");
      expect(client.getQueryData(query().queryKey)).toBeUndefined();
      client.clear();
    });

    it(`${name} keeps cached evidence when a refresh fails`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      fetch.mockResolvedValue({ data: payload, meta: {}, url: "/fixture" });
      const first = await read(client);
      fetch.mockRejectedValue(new Error("refresh failed"));
      await expect(read(client)).rejects.toThrow("refresh failed");
      expect(client.getQueryData(query().queryKey)).toEqual(first);
      expect(client.getQueryState(query().queryKey)?.status).toBe("error");
      client.clear();
    });

    for (const malformed of [null, {}, { subnets: null }, { subnets: {} }]) {
      it(`${name} retains cached data after a malformed successful response ${JSON.stringify(malformed)}`, async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        fetch.mockResolvedValue({ data: payload, meta: {}, url: "/fixture" });
        const first = await read(client);
        fetch.mockResolvedValue({ data: malformed, meta: {}, url: "/fixture" });
        await expect(read(client)).rejects.toThrow("invalid response");
        expect(client.getQueryData(query().queryKey)).toEqual(first);
        expect(client.getQueryState(query().queryKey)?.status).toBe("error");
        client.clear();
      });
    }

    it(`${name} distinguishes a successful empty catalog`, async () => {
      const client = new QueryClient();
      fetch.mockResolvedValue({
        data: { subnets: [], blocked_subnets: [] },
        meta: {},
        url: "/fixture",
      });
      expect((await read(client)).data).toEqual({});
      expect(client.getQueryState(query().queryKey)?.status).toBe("success");
      client.clear();
    });
  }

  it("normalizes degraded/failed probe states and retains netuid zero", async () => {
    const client = new QueryClient();
    fetch.mockResolvedValue({
      data: {
        subnets: [
          { netuid: 0, status: "degraded" },
          { netuid: 19, status: "failed" },
        ],
      },
      meta: {},
      url: "/fixture",
    });
    const result = await client.fetchQuery(subnetHealthMapQuery());
    expect(result.data[0]?.health).toBe("warn");
    expect(result.data[19]?.health).toBe("down");
    client.clear();
  });
});

for (const blocked of [null, {}, "invalid"]) {
  it(`rejects malformed optional blocked catalog entries: ${JSON.stringify(blocked)}`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetch.mockResolvedValue({
      data: { subnets: [], blocked_subnets: blocked },
      meta: {},
      url: "/fixture",
    });
    await expect(client.fetchQuery(agentCatalogMapQuery())).rejects.toThrow("invalid response");
    client.clear();
  });
}

it("preserves empty service-kind evidence and permits omitted optional blocked entries", async () => {
  const client = new QueryClient();
  fetch.mockResolvedValue({
    data: {
      subnets: [
        { netuid: 0, service_kinds: [] },
        { netuid: 19, service_count: 2 },
        { netuid: 20, service_kinds: [null] },
      ],
    },
    meta: {},
    url: "/fixture",
  });
  const result = await client.fetchQuery(agentCatalogMapQuery());
  expect(result.data[0]?.service_kinds).toEqual([]);
  expect(result.data[19]?.service_kinds).toBeUndefined();
  expect(result.data[20]?.service_kinds).toBeUndefined();
  client.clear();
});
