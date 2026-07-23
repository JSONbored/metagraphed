import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { staleOperationalKinds } from "../scripts/lib.ts";

const PROBE_AT = "2026-06-09T00:00:00.000Z";
const day = (n) =>
  new Date(Date.parse(PROBE_AT) - n * 86_400_000).toISOString();

describe("staleOperationalKinds (freshness auto-demotion)", () => {
  test("returns empty set when there is no probe reference time (determinism)", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subtensor-rpc"],
      healthByKind: new Map([
        ["subtensor-rpc", [{ status: "failed", last_ok: null }]],
      ]),
      probeFinishedAt: null,
    });
    assert.equal(stale.size, 0);
  });

  test("a kind verified ok within the window is not stale", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subtensor-rpc"],
      healthByKind: new Map([
        ["subtensor-rpc", [{ status: "ok", last_ok: day(2) }]],
      ]),
      probeFinishedAt: PROBE_AT,
    });
    assert.deepEqual([...stale], []);
  });

  test("a kind last ok beyond the window is stale", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subtensor-rpc"],
      healthByKind: new Map([
        ["subtensor-rpc", [{ status: "ok", last_ok: day(10) }]],
      ]),
      probeFinishedAt: PROBE_AT,
    });
    assert.deepEqual([...stale], ["subtensor-rpc"]);
  });

  test("a kind that is currently failed/degraded is stale", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subnet-api", "openapi"],
      healthByKind: new Map([
        ["subnet-api", [{ status: "failed", last_ok: day(1) }]],
        ["openapi", [{ status: "degraded", last_ok: day(1) }]],
      ]),
      probeFinishedAt: PROBE_AT,
    });
    assert.deepEqual([...stale].sort(), ["openapi", "subnet-api"]);
  });

  test("a kind with no health rows is unverified, not stale", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subtensor-rpc"],
      healthByKind: new Map(),
      probeFinishedAt: PROBE_AT,
    });
    assert.equal(stale.size, 0);
  });

  test("multiple rows: one fresh ok is enough to stay healthy", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["subtensor-wss"],
      healthByKind: new Map([
        [
          "subtensor-wss",
          [
            { status: "failed", last_ok: day(30) },
            { status: "ok", last_ok: day(1) },
          ],
        ],
      ]),
      probeFinishedAt: PROBE_AT,
    });
    assert.equal(stale.size, 0);
  });

  test("accepts a plain object lookup and honours staleAfterDays", () => {
    const stale = staleOperationalKinds({
      operationalKinds: ["archive"],
      healthByKind: { archive: [{ status: "ok", last_ok: day(5) }] },
      probeFinishedAt: PROBE_AT,
      staleAfterDays: 3,
    });
    assert.deepEqual([...stale], ["archive"]);
  });
});
