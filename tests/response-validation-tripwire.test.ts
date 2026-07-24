// Coverage for src/response-validation-tripwire.ts (types-epic B, #7860
// requirement 6) and its call site in workers/api.ts. The function is
// exercised only when METAGRAPH_VALIDATE_RESPONSES="true" -- every other
// test in the suite runs with the flag unset/"false" (createLocalArtifactEnv's
// default), so none of them reach these lines. Real fixture data is loaded
// through the same handleRequest()+createLocalArtifactEnv() pattern
// tests/zod-schemas.test.ts uses, rather than hand-built envelopes, so a
// "matching" case is grounded in an actual handler response.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { validateResponseTripwire } from "../src/response-validation-tripwire.ts";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function realEconomicsBody(): Promise<Row> {
  const env = createLocalArtifactEnv();
  const res = await handleRequest(
    req("/api/v1/economics"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  return res.json();
}

describe("validateResponseTripwire (unit)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("unknown route id is a no-op (no warn, does not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await validateResponseTripwire("not-a-covered-route", { anything: true });
    assert.equal(warn.mock.calls.length, 0);
  });

  test("a real, schema-matching envelope does not warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await realEconomicsBody();
    await validateResponseTripwire("economics", body);
    assert.equal(warn.mock.calls.length, 0);
  });

  test("an envelope that drifts from its Zod schema warns once with the route id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await realEconomicsBody();
    // Break a required field so safeParse genuinely fails, rather than
    // asserting against a hand-built (and possibly already-wrong) fixture.
    const broken = { ...body, data: { ...body.data, subnets: "not-an-array" } };
    await validateResponseTripwire("economics", broken);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0][0] as string, /economics response drifted/);
  });

  test("a loader failure is caught and warned, never thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../schemas-src/routes/economics.ts", () => {
      throw new Error("simulated module load failure");
    });
    const { validateResponseTripwire: freshTripwire } =
      await import("../src/response-validation-tripwire.ts");
    await assert.doesNotReject(freshTripwire("economics", {}));
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0][0] as string, /tripwire failed to run/);
    vi.doUnmock("../schemas-src/routes/economics.ts");
    vi.resetModules();
  });
});

describe("workers/api.ts wires the tripwire behind METAGRAPH_VALIDATE_RESPONSES", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("flag off (default): no tripwire promise is scheduled", async () => {
    const waits: Promise<unknown>[] = [];
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/api/v1/economics"),
      env as unknown as Env,
      {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      },
    );
    assert.equal(res.status, 200);
    await Promise.all(waits);
    assert.equal(waits.length, 0);
  });

  test("flag on: a real route schedules the tripwire via ctx.waitUntil and the response is unaffected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    const env = createLocalArtifactEnv({
      METAGRAPH_VALIDATE_RESPONSES: "true",
    });
    const res = await handleRequest(
      req("/api/v1/economics"),
      env as unknown as Env,
      {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(waits.length, 1);
    await Promise.all(waits);
    // Real committed fixture data matches its own Zod schema -> no drift warning.
    assert.equal(warn.mock.calls.length, 0);
  });

  // Every SCHEMA_LOADERS entry (one per pilot route) is only ever reached
  // through this flag -- exercise all 5, not just one, so each route's own
  // dynamic import + real-data parse actually runs at least once.
  const PILOT_ROUTES = [
    "/api/v1/subnets",
    "/api/v1/subnets/64",
    "/api/v1/health",
    "/api/v1/economics",
    "/api/v1/subnets/64/stake-quote?amount=1000&direction=stake",
  ];
  test("flag on: all 5 pilot routes tripwire cleanly against real fixture data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const path of PILOT_ROUTES) {
      const waits: Promise<unknown>[] = [];
      const env = createLocalArtifactEnv({
        METAGRAPH_VALIDATE_RESPONSES: "true",
      });
      const res = await handleRequest(req(path), env as unknown as Env, {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
      assert.equal(res.status, 200, path);
      await Promise.all(waits);
    }
    assert.equal(warn.mock.calls.length, 0);
  });
});
