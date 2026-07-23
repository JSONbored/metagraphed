// Unit tests for src/subnet-status-subscribe.ts (#6034).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetStatusResourceUri,
  diffChangedSubnetNetuids,
  isSubscribableMcpResourceUri,
  listSubscribableMcpResourceClasses,
  notifySubnetStatusChanged,
  parseSubnetStatusResourceUri,
  subnetStatusFingerprint,
} from "../src/subnet-status-subscribe.ts";
import type { Row } from "./row-type.ts";

type EnvArg = Parameters<typeof notifySubnetStatusChanged>[0];

describe("subnet status resource URIs (#6034)", () => {
  test("build/parse round-trip a valid netuid", () => {
    assert.equal(
      buildSubnetStatusResourceUri(42),
      "metagraph://subnet/42/status",
    );
    assert.equal(
      parseSubnetStatusResourceUri("metagraph://subnet/42/status"),
      42,
    );
    assert.equal(
      parseSubnetStatusResourceUri("metagraph://subnet/0/status"),
      0,
    );
  });

  test("parse rejects malformed URIs", () => {
    assert.equal(parseSubnetStatusResourceUri(null), null);
    assert.equal(parseSubnetStatusResourceUri("metagraph://subnet/42"), null);
    assert.equal(
      parseSubnetStatusResourceUri("metagraph://subnet/-1/status"),
      null,
    );
    assert.equal(
      parseSubnetStatusResourceUri("metagraph://subnet/x/status"),
      null,
    );
    assert.equal(
      parseSubnetStatusResourceUri("metagraph://chain/stream"),
      null,
    );
  });

  test("isSubscribableMcpResourceUri accepts chain stream and subnet status", () => {
    assert.equal(
      isSubscribableMcpResourceUri("metagraph://chain/stream"),
      true,
    );
    assert.equal(
      isSubscribableMcpResourceUri("metagraph://subnet/7/status"),
      true,
    );
    assert.equal(isSubscribableMcpResourceUri("metagraph://subnet/7"), false);
    assert.equal(
      isSubscribableMcpResourceUri("metagraph://registry/summary"),
      false,
    );
  });

  test("listSubscribableMcpResourceClasses documents both classes", () => {
    assert.deepEqual(listSubscribableMcpResourceClasses(), [
      "metagraph://chain/stream",
      "metagraph://subnet/{netuid}/status",
    ]);
  });
});

describe("subnetStatusFingerprint / diffChangedSubnetNetuids (#6034)", () => {
  test("fingerprint is stable under surface row reordering", () => {
    const a = subnetStatusFingerprint({ status: "ok", surface_count: 2 }, [
      { surface_key: "b", status: "failed" },
      { surface_key: "a", status: "ok" },
    ]);
    const b = subnetStatusFingerprint({ status: "ok", surface_count: 2 }, [
      { surface_key: "a", status: "ok" },
      { surface_key: "b", status: "failed" },
    ]);
    assert.equal(a, b);
  });

  test("diff detects health-tier change", () => {
    const prior = {
      subnets: [{ netuid: 1, status: "ok", surface_count: 1 }],
      surfaces: [{ netuid: 1, surface_key: "s1", status: "ok" }],
    };
    const next = {
      subnets: [{ netuid: 1, status: "degraded", surface_count: 1 }],
      surfaces: [{ netuid: 1, surface_key: "s1", status: "degraded" }],
    };
    assert.deepEqual(diffChangedSubnetNetuids(prior, next), [1]);
  });

  test("diff detects surface membership change", () => {
    const prior = {
      subnets: [{ netuid: 3, status: "ok", surface_count: 1 }],
      surfaces: [{ netuid: 3, surface_key: "only", status: "ok" }],
    };
    const next = {
      subnets: [{ netuid: 3, status: "ok", surface_count: 2 }],
      surfaces: [
        { netuid: 3, surface_key: "only", status: "ok" },
        { netuid: 3, surface_key: "new", status: "ok" },
      ],
    };
    assert.deepEqual(diffChangedSubnetNetuids(prior, next), [3]);
  });

  test("diff is empty when nothing meaningful changed", () => {
    const snap = {
      subnets: [{ netuid: 2, status: "ok", surface_count: 1 }],
      surfaces: [{ netuid: 2, surface_key: "s", status: "ok" }],
    };
    assert.deepEqual(diffChangedSubnetNetuids(snap, structuredClone(snap)), []);
  });

  test("cold prior reports every next netuid", () => {
    const next = {
      subnets: [
        { netuid: 5, status: "ok", surface_count: 1 },
        { netuid: 9, status: "failed", surface_count: 1 },
      ],
      surfaces: [
        { netuid: 5, surface_key: "a", status: "ok" },
        { netuid: 9, surface_key: "b", status: "failed" },
      ],
    };
    assert.deepEqual(diffChangedSubnetNetuids(null, next), [5, 9]);
  });

  test("fingerprint falls back when surface_count / surfaces / status are missing", () => {
    assert.equal(
      subnetStatusFingerprint({ status: 1 }, null),
      subnetStatusFingerprint({ status: "unknown", surface_count: 0 }, []),
    );
    assert.equal(
      subnetStatusFingerprint(null, [{ surface_id: "only", status: 9 }]),
      JSON.stringify({
        status: "unknown",
        surface_count: 1,
        surfaces: ["only:unknown"],
      }),
    );
    assert.equal(
      subnetStatusFingerprint({ status: "ok", surface_count: "x" }, [
        { status: "ok" },
      ]),
      JSON.stringify({
        status: "ok",
        surface_count: 1,
        surfaces: [":ok"],
      }),
    );
  });

  test("diff tolerates missing subnets/surfaces arrays", () => {
    assert.deepEqual(
      diffChangedSubnetNetuids({}, { subnets: [], surfaces: [] }),
      [],
    );
    assert.deepEqual(
      diffChangedSubnetNetuids(
        { subnets: [{ netuid: 1, status: "ok", surface_count: 0 }] },
        {},
      ),
      [1],
    );
  });

  test("diff skips malformed netuid entries", () => {
    const next = {
      subnets: [
        { netuid: "x", status: "ok" },
        { netuid: 4, status: "ok" },
      ],
      surfaces: [
        { netuid: "y", surface_key: "bad", status: "ok" },
        { netuid: 4, surface_key: "ok", status: "ok" },
      ],
    };
    assert.deepEqual(diffChangedSubnetNetuids(null, next), [4]);
  });

  test("diff indexes a netuid that only appears in surfaces (no rollup row)", () => {
    const prior = { subnets: [], surfaces: [] };
    const next = {
      subnets: [],
      surfaces: [{ netuid: 12, surface_key: "solo", status: "ok" }],
    };
    assert.deepEqual(diffChangedSubnetNetuids(prior, next), [12]);
  });
});

describe("notifySubnetStatusChanged (#6034)", () => {
  test("no-ops when SUBNET_STATUS_HUB is unbound", async () => {
    assert.deepEqual(
      await notifySubnetStatusChanged({} as unknown as EnvArg, [1]),
      {
        notified: false,
        reason: "unbound",
      },
    );
  });

  test("no-ops when netuid list is empty", async () => {
    assert.deepEqual(
      await notifySubnetStatusChanged(
        {
          SUBNET_STATUS_HUB: {
            idFromName: () => "global",
            get: () => ({ fetch: async () => new Response("ok") }),
          },
        } as unknown as EnvArg,
        [],
      ),
      { notified: false, reason: "no_netuids" },
    );
  });

  test("posts notify-changed to the singleton hub", async () => {
    const calls: Row[] = [];
    const result = await notifySubnetStatusChanged(
      {
        SUBNET_STATUS_HUB: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: async (url: string, init: RequestInit) => {
              calls.push({ url, body: JSON.parse(init.body as string) });
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
              });
            },
          }),
        },
      } as unknown as EnvArg,
      [1, 2],
    );
    assert.deepEqual(result, { notified: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/notify-changed$/);
    assert.deepEqual(calls[0].body, { netuids: [1, 2] });
  });

  test("returns fetch_failed when the hub throws", async () => {
    const result = await notifySubnetStatusChanged(
      {
        SUBNET_STATUS_HUB: {
          idFromName: () => "global",
          get: () => ({
            fetch: async () => {
              throw new Error("boom");
            },
          }),
        },
      } as unknown as EnvArg,
      [1],
    );
    assert.deepEqual(result, { notified: false, reason: "fetch_failed" });
  });

  test("returns status_* when the hub responds non-2xx", async () => {
    const result = await notifySubnetStatusChanged(
      {
        SUBNET_STATUS_HUB: {
          idFromName: () => "global",
          get: () => ({
            fetch: async () => new Response("nope", { status: 503 }),
          }),
        },
      } as unknown as EnvArg,
      [1],
    );
    assert.deepEqual(result, { notified: false, reason: "status_503" });
  });

  test("notifySubnetStatusChanged filters non-integer netuids", async () => {
    assert.deepEqual(
      await notifySubnetStatusChanged(
        {
          SUBNET_STATUS_HUB: {
            idFromName: () => "global",
            get: () => ({
              fetch: async () => new Response(JSON.stringify({ ok: true })),
            }),
          },
        } as unknown as EnvArg,
        [-1, 1.5, "2", null],
      ),
      { notified: false, reason: "no_netuids" },
    );
  });

  test("notifySubnetStatusChanged rejects a non-array netuids argument", async () => {
    assert.deepEqual(
      await notifySubnetStatusChanged(
        {
          SUBNET_STATUS_HUB: {
            idFromName: () => "global",
            get: () => ({
              fetch: async () => new Response(JSON.stringify({ ok: true })),
            }),
          },
        } as unknown as EnvArg,
        "1",
      ),
      { notified: false, reason: "no_netuids" },
    );
  });
});
