import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  findSurface,
  primarySurfaceForNetuid,
  verifySurface,
  SURFACE_ID_PATTERN,
} from "../src/surface-verify.mjs";

describe("surface-verify (#358)", () => {
  const surfaces = [
    {
      surface_id: "7:subnet-api:x",
      netuid: 7,
      kind: "subnet-api",
      url: "https://x",
      provider: "p",
      auth_required: false,
      probe: { enabled: true },
    },
    {
      surface_id: "7:docs:y",
      netuid: 7,
      kind: "docs",
      url: "https://y",
      provider: "p",
      probe: { enabled: false },
    },
    {
      surface_id: "9:rpc:z",
      netuid: 9,
      kind: "subtensor-rpc",
      url: "https://z",
    },
  ];

  test("findSurface matches by surface_id", () => {
    assert.equal(findSurface(surfaces, "7:subnet-api:x")?.url, "https://x");
    assert.equal(findSurface(surfaces, "nope"), null);
    assert.equal(findSurface(null, "x"), null);
    assert.equal(findSurface(surfaces, 7), null);
  });

  test("primarySurfaceForNetuid prefers a probe-enabled surface", () => {
    assert.equal(
      primarySurfaceForNetuid(surfaces, 7)?.surface_id,
      "7:subnet-api:x",
    );
    assert.equal(primarySurfaceForNetuid(surfaces, 9)?.surface_id, "9:rpc:z");
    assert.equal(primarySurfaceForNetuid(surfaces, 99), null);
    assert.equal(primarySurfaceForNetuid(null, 7), null);
  });

  test("SURFACE_ID_PATTERN accepts catalog ids, rejects traversal/junk", () => {
    assert.ok(SURFACE_ID_PATTERN.test("7:subnet-api:x"));
    assert.ok(SURFACE_ID_PATTERN.test("nodies-finney-rpc"));
    assert.ok(!SURFACE_ID_PATTERN.test("../etc/passwd"));
    assert.ok(!SURFACE_ID_PATTERN.test("a b"));
    assert.ok(!SURFACE_ID_PATTERN.test("/slash"));
  });

  test("verifySurface maps a healthy probe to callable=true", async () => {
    const okProber = async (surface) => {
      // confirms the surface_id→id bridge so the RPC branch of probeSurface works
      assert.equal(surface.id, "7:subnet-api:x");
      return {
        status: "ok",
        classification: "live",
        latency_ms: 42,
        status_code: 200,
        error: null,
        last_checked: "2026-06-16T00:00:00.000Z",
      };
    };
    const out = await verifySurface(surfaces[0], {}, okProber);
    assert.equal(out.surface_id, "7:subnet-api:x");
    assert.equal(out.callable, true);
    assert.equal(out.status, "ok");
    assert.equal(out.latency_ms, 42);
    assert.equal(out.netuid, 7);
    assert.equal(out.probed_at, "2026-06-16T00:00:00.000Z");
  });

  test("verifySurface maps a failed/dead probe to callable=false", async () => {
    const deadProber = async () => ({
      status: "failed",
      classification: "dead",
      latency_ms: null,
      status_code: null,
      error: "ECONNREFUSED",
      last_checked: null,
    });
    const out = await verifySurface(surfaces[0], {}, deadProber);
    assert.equal(out.callable, false);
    assert.equal(out.status, "failed");
    assert.equal(out.error, "ECONNREFUSED");
    assert.equal(out.latency_ms, null);
  });

  test("verifySurface treats unsafe classification as not callable", async () => {
    const unsafeProber = async () => ({
      status: "degraded",
      classification: "unsafe",
      latency_ms: 10,
    });
    const out = await verifySurface(surfaces[0], {}, unsafeProber);
    assert.equal(out.callable, false);
  });
});
