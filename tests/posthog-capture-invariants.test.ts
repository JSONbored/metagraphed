// Every PostHog capture this project makes, driven, with the invariants that
// must hold on all of them asserted on all of them.
//
// ## WHY THIS FILE EXISTS
//
// `src/usage-telemetry.ts` builds its capture body TEN TIMES -- ten copies of
// `api_key` / `event` / `distinct_id: deps.distinctId ?? USAGE_EVENT_DISTINCT_ID`
// / `properties`, differing only in the event name. Ten copies of one decision
// is not a style problem, it is a coverage problem: a rule that must hold on
// every capture is enforced by remembering to write it ten times, and
// remembering is what failed.
//
// It failed measurably. `$process_person_profile` was written on the six
// `$mcp_*` captures and NOT on `usage_event` or `$exception` -- and because
// PostHog creates a person profile when ANY event on a distinct_id omits the
// flag, the six that set it bought nothing. Profile creation ran flat at
// ~25-31/hour straight through the flag's own deploy (measured 2026-08-12),
// billing one profile per MCP session while every `$mcp_*` event politely
// said `false`.
//
// ## WHY IT IS DERIVED, AND WHY BOTH DIRECTIONS
//
// The recorder inventory is DISCOVERED from the module's exports, not listed.
// A hand list is the same failure one level up: #7860's five-route list was
// stale the day it landed and 156 routes served unchecked behind it. So a
// recorder added tomorrow fails this file until it is given a sample call --
// and a sample call naming a recorder that no longer exists fails too, since a
// one-way check would leave a renamed recorder unchecked while the file stayed
// green.
//
// This is the same mechanic as tests/serve-time-overlay-schema-sweep.ts, for
// the same reason: the defect class is never one call site, it is the one that
// was forgotten.
//
// ## WHAT IT DOES NOT DO
//
// It does not assert the ten bodies were collapsed into one. That refactor is
// worth doing and this file is what makes it safe -- but the INVARIANT is
// "every capture carries these fields", and a test that asserted the
// implementation instead would have to be rewritten by the refactor it exists
// to protect.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import * as telemetry from "../src/usage-telemetry.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };

/** Collects the bodies a recorder posts, without touching PostHog. */
function capturing() {
  const posted: Row[] = [];
  return {
    posted,
    fetch: (async (_url: unknown, init: Row) => {
      posted.push(JSON.parse(init.body as string));
      return { ok: true };
    }) as unknown as typeof fetch,
  };
}

/**
 * One sample call per recorder: enough arguments to reach the capture.
 *
 * Deliberately minimal. This file asserts what is true of EVERY capture, so a
 * sample only has to be valid enough to produce one -- the per-recorder
 * property assertions live in tests/usage-telemetry.test.ts.
 */
const SAMPLES: Record<string, (deps: Row) => Promise<unknown>> = {
  recordUsageEvent: (deps) =>
    telemetry.recordUsageEvent(
      CONFIGURED as never,
      { route: "subnets", ok: true, durationMs: 1 },
      deps as never,
    ),
  recordMcpToolCallEvent: (deps) =>
    telemetry.recordMcpToolCallEvent(
      CONFIGURED as never,
      { toolName: "get_subnet", isError: false, durationMs: 1 },
      deps as never,
    ),
  recordMcpInitializeEvent: (deps) =>
    telemetry.recordMcpInitializeEvent(
      CONFIGURED as never,
      { clientName: "test", clientVersion: "1" },
      deps as never,
    ),
  recordMcpToolsListEvent: (deps) =>
    telemetry.recordMcpToolsListEvent(
      CONFIGURED as never,
      { listedToolNames: ["get_subnet"] },
      deps as never,
    ),
  recordMcpResourcesListEvent: (deps) =>
    telemetry.recordMcpResourcesListEvent(
      CONFIGURED as never,
      {},
      deps as never,
    ),
  recordMcpResourceReadEvent: (deps) =>
    telemetry.recordMcpResourceReadEvent(
      CONFIGURED as never,
      { resourceName: "metagraph://subnets" },
      deps as never,
    ),
  recordMcpPromptsListEvent: (deps) =>
    telemetry.recordMcpPromptsListEvent(CONFIGURED as never, {}, deps as never),
  recordMcpPromptGetEvent: (deps) =>
    telemetry.recordMcpPromptGetEvent(
      CONFIGURED as never,
      { resourceName: "explain" },
      deps as never,
    ),
  recordMcpMissingCapabilityEvent: (deps) =>
    telemetry.recordMcpMissingCapabilityEvent(
      CONFIGURED as never,
      { intent: "sampling" },
      deps as never,
    ),
  recordExceptionEvent: (deps) =>
    telemetry.recordExceptionEvent(
      CONFIGURED as never,
      { error: new Error("boom"), route: "subnets" },
      deps as never,
    ),
  recordAiDegradedEvent: (deps) =>
    telemetry.recordAiDegradedEvent(
      CONFIGURED as never,
      { reason: "rate_limited" as const },
      deps as never,
    ),
  recordAiEmbeddingEvent: (deps) =>
    telemetry.recordAiEmbeddingEvent(
      CONFIGURED as never,
      { model: "m", provider: "p", latencyMs: 1, isError: false },
      deps as never,
    ),
  recordAiGenerationEvent: (deps) =>
    telemetry.recordAiGenerationEvent(
      CONFIGURED as never,
      { model: "m", provider: "p", latencyMs: 1, isError: false },
      deps as never,
    ),
};

// ── The inventory, discovered ──────────────────────────────────────────────

const DISCOVERED = Object.keys(telemetry)
  .filter(
    (name) =>
      /^record[A-Z].*Event$/.test(name) &&
      typeof (telemetry as Record<string, unknown>)[name] === "function",
  )
  .sort();

describe("every PostHog recorder is accounted for", () => {
  test("each discovered recorder has a sample call", () => {
    const missing = DISCOVERED.filter((name) => !(name in SAMPLES));
    assert.deepEqual(
      missing,
      [],
      "these recorders post to PostHog with nothing checking the invariants " +
        "every capture must satisfy — add a sample call: " +
        missing.join(", "),
    );
  });

  test("each sample names a recorder that still exists", () => {
    // The reverse direction, because a one-way check hides the other: a
    // renamed recorder would leave its sample calling nothing while this file
    // stayed green.
    const orphaned = Object.keys(SAMPLES)
      .filter((name) => !DISCOVERED.includes(name))
      .sort();
    assert.deepEqual(orphaned, [], "stale samples: " + orphaned.join(", "));
  });

  test("discovery found the recorders at all", () => {
    // An empty set makes both checks above pass on nothing.
    assert.ok(
      DISCOVERED.length >= 10,
      `discovery found only ${DISCOVERED.length} recorders — the naming ` +
        "convention this inventory relies on has changed",
    );
  });
});

// ── The invariants, on every capture ───────────────────────────────────────

describe("every capture carries what every capture must", () => {
  for (const name of DISCOVERED) {
    describe(name, () => {
      async function captureOf(deps: Row = {}) {
        const spy = capturing();
        await SAMPLES[name]({ ...deps, fetch: spy.fetch });
        assert.equal(
          spy.posted.length,
          1,
          `${name} posted ${spy.posted.length} events — the sample never ` +
            "reached a capture, so nothing below is being asserted",
        );
        return spy.posted[0];
      }

      test("decides person processing rather than inheriting the default", async () => {
        // THE ONE THAT COST MONEY. Absent is not false: PostHog processes a
        // person profile unless told otherwise, so an omitted flag is the
        // expensive direction — and one omission on a distinct_id undoes every
        // other event's `false`.
        const body = await captureOf();
        assert.equal(
          typeof (body.properties as Row).$process_person_profile,
          "boolean",
          `${name} omits $process_person_profile, so PostHog mints a person ` +
            "profile for whatever distinct_id it carries — including ids that " +
            "other captures explicitly declined to bill",
        );
      });

      test("an anonymous caller is never a person", async () => {
        const body = await captureOf({ distinctId: "ip:0123456789abcdef" });
        assert.equal((body.properties as Row).$process_person_profile, false);
      });

      test("a verified identity is a person, on every surface", async () => {
        // Two files disagreeing about whether one caller is a person is not a
        // labelling nit — one request emits on both the REST and MCP paths,
        // and the profile is created if ANY of those events asks for one.
        const body = await captureOf({
          distinctId: `${telemetry.MCP_PERSON_NAMESPACE}someone`,
        });
        assert.equal((body.properties as Row).$process_person_profile, true);
      });

      test("carries the project token and a distinct_id", async () => {
        const body = await captureOf();
        assert.equal(body.api_key, "phc_token");
        assert.equal(
          body.distinct_id,
          telemetry.USAGE_EVENT_DISTINCT_ID,
          "a capture with no resolved caller must fall back to the shared " +
            "id, never to undefined",
        );
      });

      test("a rejecting transport never escapes into the caller", async () => {
        // The refactor to a single chokepoint broke this and the per-recorder
        // suites caught it: `return capturePostHogEvent(...)` inside a `try`
        // does NOT await, so a rejected capture propagates straight past the
        // catch that exists to stop telemetry ever failing a request. It is
        // asserted here too, for all thirteen, because the next recorder to
        // be written will not have a per-recorder suite yet.
        const throwing = (async () => {
          throw new Error("network unreachable");
        }) as unknown as typeof fetch;
        assert.equal(
          await SAMPLES[name]({ fetch: throwing }),
          false,
          `${name} let a transport failure escape — telemetry must never ` +
            "surface into the request or tool path",
        );
      });

      test("names its event", async () => {
        const body = await captureOf();
        assert.equal(
          typeof body.event === "string" && body.event.length > 0,
          true,
        );
      });
    });
  }
});
