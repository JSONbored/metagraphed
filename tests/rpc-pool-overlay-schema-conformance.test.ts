// What the serve-time overlay produces must satisfy the schema of the thing it
// produces.
//
// The bug this exists to stop (#9138): `/api/v1/rpc/pools` served
// `health_source: "live-cron-prober"` on 15 of 20 endpoints -- the majority --
// while `RpcPoolSchema` declared only ["probe-derived", "missing-probe",
// "not-monitored"]. The enum was correct for the BAKED artifact; the route
// serves the OVERLAID one, and `overlayRpcPoolEligibility` injects
// `live-cron-prober` wherever the 15-minute cron snapshot has a reading.
//
// Nothing connected the two. The build-time producers were tested, the schema
// was tested, and the serve-time transform between them was tested for
// eligibility behaviour -- but no test ever asked whether its OUTPUT still fit
// the schema of the artifact it was transforming.
//
// So the assertions here run the REAL overlay and parse its REAL output. A
// hand-built fixture asserting `health_source === "live-cron-prober"` would
// have passed throughout the bug: it would be re-encoding the producer's
// assumption instead of checking it against the contract.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { overlayRpcPoolEligibility } from "../src/health-serving.ts";
import { RpcPoolSchema } from "../schemas-src/routes/providers-rpc.ts";

/**
 * A baked pool endpoint, field-for-field in the shape RpcPoolEndpointSchema
 * declares (it is `.strict()`, so an extra key is as much a failure as a
 * missing one).
 */
function bakedEndpoint(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://${id}.example`,
    provider: "example-provider",
    status: "ok",
    score: 80,
    pool_eligible: true,
    archive_support: null,
    latency_ms: 120,
    observed_at: "2026-08-02T00:00:00.000Z",
    health_source: "probe-derived",
    health_stale: false,
    last_ok: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function bakedPool(endpoints: Record<string, unknown>[]) {
  return {
    id: "finney-rpc",
    kind: "subtensor-rpc",
    endpoint_count: endpoints.length,
    eligible_count: endpoints.length,
    endpoints,
  };
}

/** A live cron reading for one endpoint id. */
function liveReading(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "ok",
    classification: "public",
    latency_ms: 88,
    last_checked: "2026-08-02T09:00:00.000Z",
    last_ok: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

describe("the rpc-pool overlay produces what RpcPoolSchema declares (#9138)", () => {
  test("an overlaid pool parses against its own schema", () => {
    const overlaid = overlayRpcPoolEligibility(
      bakedPool([bakedEndpoint("a"), bakedEndpoint("b")]),
      { endpoints: [liveReading("a"), liveReading("b")] },
    );
    const parsed = RpcPoolSchema.safeParse(overlaid);
    assert.ok(
      parsed.success,
      "the overlay produced a pool its own schema rejects: " +
        (parsed.success ? "" : JSON.stringify(parsed.error.issues[0])),
    );
  });

  test("the overlay really did rewrite health_source", () => {
    // Guards the guard. If the overlay silently stopped touching the field,
    // the parse above would still pass -- on the baked value -- and this file
    // would be asserting nothing about the value that actually broke.
    const overlaid = overlayRpcPoolEligibility(
      bakedPool([bakedEndpoint("a")]),
      { endpoints: [liveReading("a")] },
    ) as { endpoints: { health_source: string }[] };
    assert.equal(
      overlaid.endpoints[0].health_source,
      "live-cron-prober",
      "the overlay must label an endpoint it refreshed from the cron snapshot",
    );
  });

  test("an endpoint with no live reading keeps its baked value", () => {
    // This is why `unavailable` is NOT in the enum: unlike
    // overlayEndpointHealth, this overlay leaves an unmatched endpoint
    // untouched rather than marking it unavailable. If that ever changes, the
    // enum must change with it -- and the conformance parse below is what
    // would catch it.
    const overlaid = overlayRpcPoolEligibility(
      bakedPool([bakedEndpoint("a"), bakedEndpoint("orphan")]),
      { endpoints: [liveReading("a")] },
    ) as { endpoints: { id: string; health_source: string }[] };
    const orphan = overlaid.endpoints.find(
      (endpoint) => endpoint.id === "orphan",
    );
    assert.equal(
      orphan?.health_source,
      "probe-derived",
      "an endpoint with no live reading must keep the baked value, not become unavailable",
    );
    assert.ok(RpcPoolSchema.safeParse(overlaid).success);
  });

  test("every health_source the overlay can emit is declared", () => {
    // The closed set, enumerated from the overlay's own branches rather than
    // from whatever production happened to be serving when this was written --
    // a sample is not a vocabulary.
    const emitted = new Set<string>();
    for (const baked of ["probe-derived", "missing-probe", "not-monitored"]) {
      for (const live of [true, false]) {
        const overlaid = overlayRpcPoolEligibility(
          bakedPool([bakedEndpoint("a", { health_source: baked })]),
          { endpoints: live ? [liveReading("a")] : [] },
        ) as { endpoints: { health_source: string }[] };
        emitted.add(overlaid.endpoints[0].health_source);
        assert.ok(
          RpcPoolSchema.safeParse(overlaid).success,
          `overlaying a ${baked} endpoint (live: ${live}) produced a pool the schema rejects`,
        );
      }
    }
    assert.ok(
      emitted.has("live-cron-prober"),
      "the overlay's live branch was never exercised",
    );

    // Set EQUALITY, not containment. A parse-only check catches an enum that
    // is too narrow (the bug) but never one that is too wide -- and a value
    // the producer cannot emit is exactly what stops this enum noticing the
    // next drift. `unavailable` is the concrete case: overlayEndpointHealth
    // emits it, this overlay does not, and adding it "for symmetry" would be
    // silent.
    const declared = new Set(
      (
        RpcPoolSchema.shape.endpoints.element.shape
          .health_source as unknown as { options: string[] }
      ).options,
    );
    assert.deepEqual(
      [...declared].sort(),
      [...emitted].sort(),
      "the declared health_source vocabulary and the set this overlay can " +
        "actually emit have diverged -- a missing value makes the route serve " +
        "responses its own schema rejects, an extra one stops the enum " +
        "catching that",
    );
  });
});
