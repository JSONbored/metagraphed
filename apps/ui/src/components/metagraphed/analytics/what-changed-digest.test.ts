import { describe, expect, it } from "vitest";
import {
  buildDigestItems,
  countByKind,
  dayKey,
  groupByDay,
  type DigestSources,
} from "./what-changed-digest";
import type { ChainIdentityChange, EndpointIncident } from "@/lib/metagraphed/types";

const NOW = Date.parse("2026-07-26T20:00:00.000Z");
const CUTOFF = NOW - 7 * 86_400_000;

function sources(over: Partial<DigestSources> = {}): DigestSources {
  return { changelog: [], incidents: [], identity: [], runtime: [], ...over };
}

describe("buildDigestItems (#8257)", () => {
  it("merges all four sources newest-first", () => {
    const items = buildDigestItems(
      sources({
        changelog: [
          { id: "a", title: "Added a fixture", kind: "artifact", at: "2026-07-24T10:00:00Z" },
        ],
        incidents: [
          {
            id: "i1",
            message: "Endpoint down",
            started_at: "2026-07-26T10:00:00Z",
          } as EndpointIncident,
        ],
        identity: [
          {
            netuid: 64,
            subnet_name: "Chutes",
            block_number: 8_706_218,
            observed_at: "2026-07-25T10:00:00Z",
          } as ChainIdentityChange,
        ],
        runtime: [
          { spec_version: 300, block_number: 8_700_000, observed_at: "2026-07-23T10:00:00Z" },
        ],
      }),
      CUTOFF,
    );
    expect(items.map((i) => i.kind)).toEqual(["incident", "identity", "registry", "runtime"]);
  });

  it("drops items with no parseable timestamp rather than dating them to now", () => {
    // An undated item bucketed under today's heading would read as "this just
    // happened", which is exactly the claim we can't make.
    const items = buildDigestItems(
      sources({
        changelog: [
          { id: "no-date", title: "Undated" },
          { id: "bad-date", title: "Garbage", at: "not a date" },
        ],
      }),
      CUTOFF,
    );
    expect(items).toEqual([]);
  });

  it("excludes anything older than the cutoff", () => {
    const items = buildDigestItems(
      sources({ changelog: [{ id: "old", title: "Old", at: "2026-06-01T00:00:00Z" }] }),
      CUTOFF,
    );
    expect(items).toEqual([]);
  });

  it("deep-links an identity change to its subnet and a runtime upgrade to /chain/runtime", () => {
    const items = buildDigestItems(
      sources({
        identity: [
          {
            netuid: 8,
            subnet_name: "Taoshi",
            observed_at: "2026-07-26T01:00:00Z",
          } as ChainIdentityChange,
        ],
        runtime: [{ spec_version: 301, block_number: 1, observed_at: "2026-07-26T02:00:00Z" }],
      }),
      CUTOFF,
    );
    const identity = items.find((i) => i.kind === "identity");
    expect(identity?.href).toEqual({ to: "/subnets/$netuid", params: { netuid: "8" } });
    expect(items.find((i) => i.kind === "runtime")?.href).toEqual({ to: "/chain/runtime" });
  });

  it("marks an unresolved incident ongoing and a resolved one resolved", () => {
    const items = buildDigestItems(
      sources({
        incidents: [
          { id: "a", message: "A", started_at: "2026-07-26T01:00:00Z" } as EndpointIncident,
          {
            id: "b",
            message: "B",
            state: "warn",
            started_at: "2026-07-26T02:00:00Z",
            ended_at: 1,
          } as unknown as EndpointIncident,
        ],
      }),
      CUTOFF,
    );
    expect(items.find((i) => i.id === "incident:a")?.detail).toBe("ongoing");
    expect(items.find((i) => i.id === "incident:b")?.detail).toContain("resolved");
  });
});

describe("groupByDay", () => {
  it("buckets by local day, preserving newest-first order", () => {
    const items = buildDigestItems(
      sources({
        changelog: [
          { id: "1", title: "one", at: "2026-07-26T09:00:00Z" },
          { id: "2", title: "two", at: "2026-07-26T08:00:00Z" },
          { id: "3", title: "three", at: "2026-07-20T08:00:00Z" },
        ],
      }),
      CUTOFF,
    );
    const days = groupByDay(items);
    expect(days).toHaveLength(2);
    expect(days[0]!.items.map((i) => i.title)).toEqual(["one", "two"]);
    expect(days[1]!.items.map((i) => i.title)).toEqual(["three"]);
  });

  it("keys on the viewer's local date, not UTC", () => {
    // An evening event in a positive-offset zone is still "today" locally;
    // keying on the UTC date would file it under tomorrow.
    const iso = "2026-07-26T23:30:00.000Z";
    const local = new Date(iso);
    expect(dayKey(iso)).toBe(
      `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`,
    );
  });
});

describe("countByKind", () => {
  it("counts every kind, including the zeroes a chip still needs to show", () => {
    const items = buildDigestItems(
      sources({ changelog: [{ id: "1", title: "one", at: "2026-07-26T09:00:00Z" }] }),
      CUTOFF,
    );
    expect(countByKind(items)).toEqual({ registry: 1, incident: 0, identity: 0, runtime: 0 });
  });
});
