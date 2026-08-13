// The conformance monitor's decision rule (#9141), tested without a network.
//
// Every edge here is a decision to SKIP rather than to fail, and that is the
// whole design: a conformance check that also reports availability goes red for
// reasons that are not drift, and a monitor that cries wolf gets ignored -- the
// same rule that shaped check-safe-mode's success-keyed baseline (#9125).
//
// The one thing it must NOT be forgiving about is a body that genuinely does
// not match its schema, because that is a response a client generated from our
// own openapi.json will reject.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildValidator,
  driftRefusal,
  evaluateResponse,
} from "../scripts/check-response-conformance.ts";

/**
 * A miniature spec with the same SHAPE as ours: a response schema that is only
 * a `$ref` into `components`. That indirection is the reason `buildValidator`
 * compiles through a JSON pointer -- a detached sub-schema resolves no refs at
 * all, and gets it wrong by failing EVERY route rather than none.
 */
const SPEC = {
  openapi: "3.1.0",
  paths: {
    "/api/v1/things": {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ThingsEnvelope" },
              },
            },
          },
        },
      },
    },
    "/api/v1/nothing": { get: { responses: { "200": {} } } },
  },
  components: {
    schemas: {
      ThingsEnvelope: {
        type: "object",
        required: ["ok", "data"],
        properties: {
          ok: { type: "boolean" },
          data: {
            type: "object",
            required: ["things"],
            properties: {
              source: { enum: ["baked", "live"] },
              things: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "kind"],
                  properties: {
                    id: { type: "string" },
                    kind: { enum: ["a", "b"] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const validator = buildValidator(SPEC, "/api/v1/things");

function evaluate(body: unknown, status = 200) {
  return evaluateResponse({ status, body, validator });
}

describe("the response-conformance rule (#9141)", () => {
  test("a $ref-only response schema compiles at all", () => {
    // Guards the guard. If ref resolution broke, `buildValidator` would either
    // throw or reject everything -- and a check that fails all 244 routes reads
    // as a broken tool, so it gets muted rather than investigated.
    assert.ok(validator, "the validator failed to compile");
    assert.deepEqual(
      evaluate({ ok: true, data: { source: "baked", things: [] } }).violations,
      [],
      "a valid body must produce no violations",
    );
  });

  test("a value outside a declared enum is a violation, naming where", () => {
    // This is #9138/#9142 in miniature: a serve-time value the schema forbids.
    const { violations } = evaluate({
      ok: true,
      data: { source: "live-cron-prober", things: [] },
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "/data/source");
    assert.equal(violations[0].route, "/api/v1/things");
  });

  test("every violation is reported, not just the first", () => {
    // The #9142 lesson. /api/v1/rpc/pools had two violations on one route and
    // the manual audit reported one, so fixing the first surfaced the second
    // as if it were a new regression.
    const { violations } = evaluate({
      ok: true,
      data: {
        source: "nope",
        things: [{ id: "x", kind: "not-a-kind" }],
      },
    });
    const paths = violations.map((violation) => violation.path).sort();
    assert.ok(
      paths.includes("/data/source"),
      `expected the source violation, got ${paths.join(", ")}`,
    );
    assert.ok(
      paths.some((path) => path.startsWith("/data/things/0")),
      `expected the nested item violation, got ${paths.join(", ")}`,
    );
  });

  test("a schema-stable empty body from a degraded tier passes", () => {
    // A degraded tier answers with a well-formed empty collection (#9110/#9114).
    // That is correct and must not alert: this checks SHAPE, not content. If it
    // failed here, the monitor would go red every time a tier degraded and
    // would be switched off within a week.
    assert.deepEqual(
      evaluate({ ok: true, data: { things: [] } }).violations,
      [],
    );
  });

  test("a non-200 is skipped, not failed", () => {
    // Availability is check-self-health's job. Judging a 503 here would make
    // this monitor red for something it does not measure.
    for (const status of [404, 500, 503]) {
      const verdict = evaluate({ ok: false }, status);
      assert.equal(verdict.skipped, `http ${status}`);
      assert.deepEqual(verdict.violations, []);
    }
  });

  test("a route with no declared JSON schema is skipped", () => {
    const none = buildValidator(SPEC, "/api/v1/nothing");
    assert.equal(none, null, "a route with no 200 schema has nothing to check");
    const verdict = evaluateResponse({
      status: 200,
      body: { anything: true },
      validator: none,
    });
    assert.equal(verdict.skipped, "no declared 200 schema");
    assert.deepEqual(verdict.violations, []);
  });

  test("an always-passing validator would be caught", () => {
    // Mutation guard in the file itself: if `buildValidator` were reduced to
    // "() => []", the negative cases above would silently pass. Prove the
    // validator can distinguish, by giving it a body that must fail.
    const verdict = evaluate({ ok: true, data: {} });
    assert.ok(
      verdict.violations.length > 0,
      "a body missing a required property must be reported -- a validator " +
        "that never reports is indistinguishable from a healthy API",
    );
  });
});

describe("a tripwire refusal is drift wearing a 500 (#10987)", () => {
  // On 2026-08-13 this check reported "OK: all 204 checked routes match their
  // published schemas" while /api/v1/subnets/{netuid}/overview answered 500 to
  // every caller -- for the exact drift it exists to find. The serve-time
  // tripwire turns drift into a 500, and "skip non-200" then hid the route
  // that was hardest down. Both rules were individually right.
  const refusalBody = (message: string) => ({
    ok: false,
    schema_version: 1,
    data: null,
    error: { code: "response_schema_drift", message },
  });

  test("a refusal is a VIOLATION, not a skip", () => {
    const verdict = evaluateResponse({
      status: 500,
      body: refusalBody("The subnet-overview response did not match."),
      validator,
      route: "/api/v1/subnets/{netuid}/overview",
    });
    assert.equal(verdict.skipped, null, "a refusal must not be skipped");
    assert.equal(verdict.violations.length, 1);
    assert.equal(
      verdict.violations[0]!.route,
      "/api/v1/subnets/{netuid}/overview",
      "the violation must name the route -- no validator produced it",
    );
  });

  test("the refusal's own message rides along, because it IS the diagnosis", () => {
    const verdict = evaluateResponse({
      status: 500,
      body: refusalBody("unrecognized_keys: name, latency_sample_count"),
      validator,
    });
    assert.match(verdict.violations[0]!.message, /latency_sample_count/);
  });

  test("a refusal with no message still reports, naming the code", () => {
    const verdict = evaluateResponse({
      status: 500,
      body: { error: { code: "response_schema_drift" } },
      validator,
    });
    assert.equal(verdict.violations.length, 1);
    assert.match(verdict.violations[0]!.message, /response_schema_drift/);
  });

  test("availability is STILL not this monitor's job", () => {
    // The original rule, preserved: a 503 or a non-drift 500 is an outage, and
    // going red for it is what makes a monitor ignorable.
    for (const body of [
      { ok: false, error: { code: "unavailable", message: "cold store" } },
      { ok: false, error: { code: "internal_error", message: "boom" } },
    ]) {
      const verdict = evaluateResponse({ status: 503, body, validator });
      assert.equal(verdict.skipped, "http 503");
      assert.deepEqual(verdict.violations, []);
    }
  });

  test("driftRefusal reads only a real refusal envelope", () => {
    // Every shape a live 500 body can arrive in, including the edge error page
    // that parses to null.
    assert.equal(driftRefusal(null), null);
    assert.equal(driftRefusal("<!doctype html>"), null);
    assert.equal(driftRefusal({}), null);
    assert.equal(driftRefusal({ error: null }), null);
    assert.equal(driftRefusal({ error: "boom" }), null);
    assert.equal(driftRefusal({ error: { code: "not_found" } }), null);
    assert.equal(
      driftRefusal({ error: { code: "response_schema_drift", message: 42 } }),
      "the route refused its own response (response_schema_drift)",
      "a non-string message falls back to the code rather than throwing",
    );
  });
});
