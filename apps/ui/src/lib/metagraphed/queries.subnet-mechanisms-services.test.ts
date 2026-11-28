import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { subnetMechanismsQuery, subnetServicesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(url: string, data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url,
  });
}

async function runMechanisms(netuid: number) {
  const opts = subnetMechanismsQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runServices(netuid: number) {
  const opts = subnetServicesQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

beforeEach(() => mockedApiFetch.mockReset());

describe("subnetMechanismsQuery", () => {
  it("reads one subnet's registry, ordered by mechid", async () => {
    resolveWith("/api/v1/subnets/68/mechanisms", {
      schema_version: 1,
      netuid: 68,
      mechanism_count: 2,
      captured_at: "2026-11-28T19:00:00.000Z",
      mechanisms: [
        {
          mechid: 1,
          emission_split: 0.2857,
          consensus_mode: "yuma",
          captured_at: "2026-11-28T19:00:00.000Z",
        },
        {
          mechid: 0,
          emission_split: 0.7143,
          consensus_mode: "yuma",
          captured_at: "2026-11-28T19:00:00.000Z",
        },
      ],
    });
    const result = await runMechanisms(68);
    expect(mockedApiFetch.mock.calls[0]?.[0]).toBe("/api/v1/subnets/68/mechanisms");
    expect(result.data).toEqual({
      netuid: 68,
      mechanism_count: 2,
      captured_at: "2026-11-28T19:00:00.000Z",
      mechanisms: [
        {
          mechid: 0,
          emission_split: 0.7143,
          consensus_mode: "yuma",
          captured_at: "2026-11-28T19:00:00.000Z",
        },
        {
          mechid: 1,
          emission_split: 0.2857,
          consensus_mode: "yuma",
          captured_at: "2026-11-28T19:00:00.000Z",
        },
      ],
    });
  });

  it("keeps the decline a decline", async () => {
    resolveWith("/api/v1/subnets/3/mechanisms", {
      schema_version: 1,
      netuid: 3,
      mechanism_count: null,
      captured_at: null,
      mechanisms: [],
    });
    const result = await runMechanisms(3);
    expect(result.data).toEqual({
      netuid: 3,
      mechanism_count: null,
      captured_at: null,
      mechanisms: [],
    });
  });

  it("drops a mechanism it cannot address and nulls a share outside 0..1", async () => {
    resolveWith("/api/v1/subnets/12/mechanisms", {
      netuid: 12,
      mechanism_count: -1,
      mechanisms: [
        { mechid: -1, emission_split: 0.5 },
        { mechid: 1.5, emission_split: 0.5 },
        { emission_split: 0.5 },
        "not a row",
        { mechid: 0, emission_split: 1.2, consensus_mode: "" },
        { mechid: 1, emission_split: null, consensus_mode: "null" },
      ],
    });
    const result = await runMechanisms(12);
    expect(result.data).toEqual({
      netuid: 12,
      mechanism_count: null,
      captured_at: null,
      mechanisms: [
        { mechid: 0, emission_split: null, consensus_mode: null, captured_at: null },
        { mechid: 1, emission_split: null, consensus_mode: "null", captured_at: null },
      ],
    });
  });
});

describe("subnetServicesQuery", () => {
  it("reads the bindings at the last whole read", async () => {
    resolveWith("/api/v1/subnets/19/services", {
      schema_version: 1,
      netuid: 19,
      service_count: 1,
      captured_at: "2026-11-28T18:46:32.612Z",
      services: [
        {
          hotkey: "5F-example-hotkey",
          service_url: "https://example.com/services.json",
          set_at: null,
          captured_at: "2026-11-28T18:46:32.612Z",
        },
      ],
    });
    const result = await runServices(19);
    expect(mockedApiFetch.mock.calls[0]?.[0]).toBe("/api/v1/subnets/19/services");
    expect(result.data).toEqual({
      netuid: 19,
      service_count: 1,
      captured_at: "2026-11-28T18:46:32.612Z",
      services: [
        {
          hotkey: "5F-example-hotkey",
          service_url: "https://example.com/services.json",
          set_at: null,
          captured_at: "2026-11-28T18:46:32.612Z",
        },
      ],
    });
  });

  it("keeps a measured zero apart from the decline", async () => {
    resolveWith("/api/v1/subnets/3/services", {
      netuid: 3,
      service_count: 0,
      captured_at: "2026-11-28T18:46:32.612Z",
      services: [],
    });
    expect((await runServices(3)).data).toMatchObject({
      service_count: 0,
      captured_at: "2026-11-28T18:46:32.612Z",
    });

    resolveWith("/api/v1/subnets/3/services", {
      netuid: 3,
      service_count: null,
      captured_at: null,
      services: [],
    });
    expect((await runServices(3)).data).toMatchObject({
      service_count: null,
      captured_at: null,
    });
  });

  it("drops a binding with no hotkey and never fabricates a URL or a block", async () => {
    resolveWith("/api/v1/subnets/51/services", {
      netuid: 51,
      service_count: 2,
      services: [
        { service_url: "https://example.com/" },
        { hotkey: "", service_url: "https://example.com/" },
        { hotkey: "5F-second-hotkey", service_url: 42, set_at: -3 },
      ],
    });
    const result = await runServices(51);
    expect(result.data.services).toEqual([
      { hotkey: "5F-second-hotkey", service_url: "", set_at: null, captured_at: null },
    ]);
  });
});
