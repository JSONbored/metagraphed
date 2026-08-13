// Coverage for src/response-validation-tripwire.ts and its call sites.
//
// The tripwire shipped as a five-route pilot behind an off-by-default flag and
// stayed that way: 156 of 161 routes served unchecked, and the five that were
// listed never ran either. It is DERIVED now -- a route's artifact resolves to
// a component id, and the registry hands back the Zod node -- and it THROWS,
// so a response the published contract does not describe never reaches a
// caller. These cover both halves.
//
// Real fixture data throughout, loaded through handleRequest() +
// createLocalArtifactEnv(), so a "matching" case is grounded in an actual
// handler response rather than a hand-built envelope that may already be wrong.
import assert from "node:assert/strict";
import { z } from "zod";
import { successEnvelopeSchema } from "../schemas-src/envelope.ts";
import { afterEach, describe, test, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import {
  ResponseSchemaDriftError,
  validateResponseTripwire,
} from "../src/response-validation-tripwire.ts";
import { COMPONENT_SCHEMAS_BY_ID } from "../schemas-src/openapi-registry.ts";
import type { Row } from "./row-type.ts";

const ECONOMICS_ARTIFACT = "/metagraph/economics.json";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function realBody(path: string): Promise<Row> {
  const env = createLocalArtifactEnv();
  const res = await handleRequest(req(path), env as unknown as Env, {});
  assert.equal(res.status, 200, `${path} did not answer 200`);
  return res.json();
}

describe("validateResponseTripwire (unit)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no artifact path is a no-op -- nothing to resolve a schema from", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await validateResponseTripwire("whatever", { anything: true });
    assert.equal(warn.mock.calls.length, 0);
  });

  test("an artifact with no contract entry is skipped, not failed", async () => {
    // validate:openapi owns that invariant; the tripwire must not take a route
    // down over it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await assert.doesNotReject(
      validateResponseTripwire("x", {}, "/metagraph/not-a-real-artifact.json"),
    );
    assert.equal(warn.mock.calls.length, 0);
  });

  test("a real, schema-matching envelope passes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await realBody("/api/v1/economics");
    await assert.doesNotReject(
      validateResponseTripwire("economics", body, ECONOMICS_ARTIFACT),
    );
    assert.equal(warn.mock.calls.length, 0);
  });

  test("an envelope that drifts THROWS, carrying the route id", async () => {
    const body = await realBody("/api/v1/economics");
    // Break a required field so safeParse genuinely fails, rather than
    // asserting against a hand-built (and possibly already-wrong) fixture.
    const broken = { ...body, data: { ...body.data, subnets: "not-an-array" } };
    await assert.rejects(
      validateResponseTripwire("economics", broken, ECONOMICS_ARTIFACT),
      (err: unknown) => {
        assert.ok(err instanceof ResponseSchemaDriftError);
        assert.equal(err.routeId, "economics");
        assert.ok(err.detail, "the parse error must travel with it");
        return true;
      },
    );
  });

  test("the tripwire's OWN failure is warned, never thrown", async () => {
    // A drift is the route's fault and must fail the request. A broken import
    // is the tripwire's fault and must not.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../src/contracts.ts", () => {
      throw new Error("simulated module load failure");
    });
    const { validateResponseTripwire: freshTripwire } =
      await import("../src/response-validation-tripwire.ts");
    await assert.doesNotReject(
      freshTripwire("economics", {}, ECONOMICS_ARTIFACT),
    );
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0][0] as string, /tripwire failed to run/);
    vi.doUnmock("../src/contracts.ts");
    vi.resetModules();
  });
});

describe("coverage is DERIVED, not listed", () => {
  test("every registered component is reachable by id", async () => {
    // The pilot hand-listed five loaders. The registry has 300-odd components
    // and populates this map itself, so a route converted tomorrow is covered
    // the moment it is registered.
    assert.ok(
      COMPONENT_SCHEMAS_BY_ID.size > 300,
      `expected the whole registry, got ${COMPONENT_SCHEMAS_BY_ID.size}`,
    );
    for (const id of ["EconomicsArtifact", "SubnetsArtifact", "GapsArtifact"]) {
      assert.ok(COMPONENT_SCHEMAS_BY_ID.get(id), `${id} is not resolvable`);
    }
  });

  test("a route far outside the original five validates cleanly", async () => {
    // `gaps` was never one of the pilots, so before this it served unchecked.
    const body = await realBody("/api/v1/gaps?limit=5");
    await assert.doesNotReject(
      validateResponseTripwire("gaps", body, "/metagraph/gaps.json"),
    );
  });
});

describe("an artifact whose component nothing registers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("is warned once and skipped, never failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../schemas-src/openapi-registry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../schemas-src/openapi-registry.ts")
      >("../schemas-src/openapi-registry.ts");
      return { ...actual, COMPONENT_SCHEMAS_BY_ID: new Map() };
    });
    const { validateResponseTripwire: freshTripwire } =
      await import("../src/response-validation-tripwire.ts");
    await assert.doesNotReject(
      freshTripwire("economics", {}, ECONOMICS_ARTIFACT),
    );
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0][0] as string, /nothing registers/);
    // ONCE: the second call must not re-resolve or re-warn.
    await freshTripwire("economics", {}, ECONOMICS_ARTIFACT);
    assert.equal(warn.mock.calls.length, 1);
    vi.doUnmock("../schemas-src/openapi-registry.ts");
    vi.resetModules();
  });
});

describe("workers/api.ts fails the request on drift", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("flag off: a drifting response is still served", async () => {
    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "false";
    const res = await handleRequest(
      req("/api/v1/economics"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
  });

  /** Make the tripwire itself report a drift, so the CALL SITE is what is
   * under test: does a throw become a 500 instead of a served body? */
  async function withDriftingTripwire<T>(run: (handle: never) => Promise<T>) {
    vi.resetModules();
    vi.doMock("../src/response-validation-tripwire.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/response-validation-tripwire.ts")
      >("../src/response-validation-tripwire.ts");
      return {
        ...actual,
        validateResponseTripwire: async (routeId: string) => {
          throw new actual.ResponseSchemaDriftError(routeId, "forced drift");
        },
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleRequest: freshHandle } = await import("../workers/api.ts");
    try {
      return await run(freshHandle as never);
    } finally {
      vi.doUnmock("../src/response-validation-tripwire.ts");
      vi.resetModules();
    }
  }

  test("flag on: a DRIFTING response is refused with a 500, not served", async () => {
    // The whole point of throwing: the route must refuse rather than ship a
    // body the published contract does not describe.
    const body = await withDriftingTripwire(async (handle) => {
      const env = createLocalArtifactEnv() as Row;
      env.METAGRAPH_VALIDATE_RESPONSES = "true";
      const res = await (handle as unknown as typeof handleRequest)(
        req("/api/v1/economics"),
        env as unknown as Env,
        {},
      );
      assert.equal(res.status, 500);
      return (await res.json()) as Row;
    });
    assert.equal((body.error as Row).code, "response_schema_drift");
  });

  test("flag on: the refusal FILES A FAULT naming the route (#10897)", async () => {
    // Three published routes were down for 26 hours and error tracking showed
    // nothing: the refusal was correct-by-design and silent, visible only as
    // usage_event ok:false, and a latency sweep found it before any alarm. A
    // published route refusing every request is a DOWN route — the 500 must
    // carry an exception event naming it, with the drift detail in the
    // message, because the unrecognized keys ARE the diagnosis.
    vi.resetModules();
    const captured: Row[] = [];
    vi.doMock("../src/response-validation-tripwire.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/response-validation-tripwire.ts")
      >("../src/response-validation-tripwire.ts");
      return {
        ...actual,
        validateResponseTripwire: async (routeId: string) => {
          throw new actual.ResponseSchemaDriftError(routeId, [
            { code: "unrecognized_keys", keys: ["stray_field"] },
          ]);
        },
      };
    });
    vi.doMock("../src/usage-telemetry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/usage-telemetry.ts")
      >("../src/usage-telemetry.ts");
      return {
        ...actual,
        recordExceptionEvent: async (_env: unknown, event: Row) => {
          captured.push(event);
          return true;
        },
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleRequest: freshHandle } = await import("../workers/api.ts");
    try {
      const env = createLocalArtifactEnv() as Row;
      env.METAGRAPH_VALIDATE_RESPONSES = "true";
      const waits: Promise<unknown>[] = [];
      const res = await (freshHandle as unknown as typeof handleRequest)(
        req("/api/v1/economics"),
        env as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never,
      );
      assert.equal(res.status, 500);
      await Promise.all(waits);
      const fault = captured.find(
        (e) => e.errorCode === "response_schema_drift",
      );
      assert.ok(fault, "the refusal must file a fault, not just a 500");
      // The route rides in the event, so the fingerprint separates one
      // drifted route's issue from another's instead of cross-throttling.
      assert.equal(fault!.route, "economics");
      assert.match(
        String((fault!.error as Error).message),
        /stray_field/,
        "the drift detail must reach the alarm — it is the diagnosis",
      );
    } finally {
      vi.doUnmock("../src/response-validation-tripwire.ts");
      vi.doUnmock("../src/usage-telemetry.ts");
      vi.resetModules();
    }
  });

  test("flag on: subnet-stake-quote refuses a drifting response too", async () => {
    // Its own call site -- the route is matched and returned early in
    // workers/api.ts, before the generic envelope path, so it needs its own.
    await withDriftingTripwire(async (handle) => {
      const env = createLocalArtifactEnv() as Row;
      env.METAGRAPH_VALIDATE_RESPONSES = "true";
      const res = await (handle as unknown as typeof handleRequest)(
        req("/api/v1/subnets/1/stake-quote?amount=1&direction=stake"),
        env as unknown as Env,
        {},
      );
      assert.equal(res.status, 500);
      const body = (await res.json()) as Row;
      assert.equal((body.error as Row).code, "response_schema_drift");
    });
  });

  test("flag on: subnet-stake-quote's refusal FILES A FAULT too (#10901)", async () => {
    // #10898 alarmed the dispatcher's refusal and left this inline site
    // silent -- the exact invisibility #10897 closed, still live for one
    // published route. Same drill as the dispatcher's fault test: force a
    // drift, capture the recorder, and demand the event names the route with
    // the drift detail in the message.
    vi.resetModules();
    const captured: Row[] = [];
    vi.doMock("../src/response-validation-tripwire.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/response-validation-tripwire.ts")
      >("../src/response-validation-tripwire.ts");
      return {
        ...actual,
        validateResponseTripwire: async (routeId: string) => {
          throw new actual.ResponseSchemaDriftError(routeId, [
            { code: "unrecognized_keys", keys: ["stray_quote_field"] },
          ]);
        },
      };
    });
    vi.doMock("../src/usage-telemetry.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/usage-telemetry.ts")
      >("../src/usage-telemetry.ts");
      return {
        ...actual,
        recordExceptionEvent: async (_env: unknown, event: Row) => {
          captured.push(event);
          return true;
        },
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleRequest: freshHandle } = await import("../workers/api.ts");
    try {
      const env = createLocalArtifactEnv() as Row;
      env.METAGRAPH_VALIDATE_RESPONSES = "true";
      const waits: Promise<unknown>[] = [];
      const res = await (freshHandle as unknown as typeof handleRequest)(
        req("/api/v1/subnets/1/stake-quote?amount=1&direction=stake"),
        env as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never,
      );
      assert.equal(res.status, 500);
      await Promise.all(waits);
      const fault = captured.find(
        (e) => e.errorCode === "response_schema_drift",
      );
      assert.ok(fault, "the refusal must file a fault, not just a 500");
      assert.equal(fault!.route, "subnet-stake-quote");
      assert.match(
        String((fault!.error as Error).message),
        /stray_quote_field/,
        "the drift detail must reach the alarm — it is the diagnosis",
      );
    } finally {
      vi.doUnmock("../src/response-validation-tripwire.ts");
      vi.doUnmock("../src/usage-telemetry.ts");
      vi.resetModules();
    }
  });

  test("a NON-drift throw propagates -- it is not swallowed as a drift", async () => {
    // The tripwire swallows its own faults, so only a drift should ever escape
    // it. If something else does, that is a bug in the tripwire and the call
    // site must not disguise it as a schema problem.
    vi.resetModules();
    vi.doMock("../src/response-validation-tripwire.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/response-validation-tripwire.ts")
      >("../src/response-validation-tripwire.ts");
      return {
        ...actual,
        validateResponseTripwire: async () => {
          throw new Error("not a drift");
        },
      };
    });
    const { handleRequest: freshHandle } = await import("../workers/api.ts");
    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "true";
    await assert.rejects(
      freshHandle(req("/api/v1/economics"), env as unknown as Env, {}),
      /not a drift/,
    );
    vi.doUnmock("../src/response-validation-tripwire.ts");
    vi.resetModules();
  });

  test("subnet-stake-quote also propagates a NON-drift throw", async () => {
    // Its own call site needs its own proof: the route is matched and returned
    // early, so it does not share handleApiRequest's catch.
    vi.resetModules();
    vi.doMock("../src/response-validation-tripwire.ts", async () => {
      const actual = await vi.importActual<
        typeof import("../src/response-validation-tripwire.ts")
      >("../src/response-validation-tripwire.ts");
      return {
        ...actual,
        validateResponseTripwire: async () => {
          throw new Error("not a drift");
        },
      };
    });
    const { handleRequest: freshHandle } = await import("../workers/api.ts");
    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "true";
    await assert.rejects(
      freshHandle(
        req("/api/v1/subnets/1/stake-quote?amount=1&direction=stake"),
        env as unknown as Env,
        {},
      ),
      /not a drift/,
    );
    vi.doUnmock("../src/response-validation-tripwire.ts");
    vi.resetModules();
  });

  test("flag on: a real route still answers 200", async () => {
    // The whole suite runs with the flag ON now (wrangler.jsonc), so this is
    // the case that matters: validation is in the response path and must not
    // fail a route whose schema is right.
    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "true";
    for (const path of [
      "/api/v1/economics",
      "/api/v1/subnets?limit=3",
      "/api/v1/health",
      "/api/v1/gaps?limit=3",
      "/api/v1/curation?limit=3",
    ]) {
      const res = await handleRequest(req(path), env as unknown as Env, {});
      assert.equal(res.status, 200, `${path} did not answer 200`);
    }
  });
});

// ── The REST tripwire validates the wire too (#10972) ───────────────────────
//
// It does not currently trip on an undefined-valued key, and only because the
// components involved happen to declare those fields optional. That is which
// fields drifted first, not a difference in kind — so the same round-trip
// applies here, and these pin it rather than leaving it to luck.
describe("the REST tripwire validates what is sent", () => {
  const envelope = (data: unknown) => ({
    ok: true,
    schema_version: 1,
    data,
    meta: { contract_version: "x" },
  });

  test("an undefined-valued key does not fail a response that serializes clean", async () => {
    const built = {
      schema_version: 1,
      generated_at: "2026-08-13T00:00:00.000Z",
      gaps: [],
      // The shape a `{...spread}` of an absent artifact produces.
      notes: undefined,
    };
    assert.equal(
      JSON.stringify(built).includes("notes"),
      false,
      "the premise: serialization drops the key, so the client never sees it",
    );
    await assert.doesNotReject(
      validateResponseTripwire("gaps", envelope(built), "/metagraph/gaps.json"),
    );
  });

  test("a payload that cannot be serialized is left to the parse", async () => {
    // Swallowing a circular structure would make the tripwire report success
    // on something it never checked.
    const circular: Record<string, unknown> = {
      schema_version: 1,
      generated_at: "2026-08-13T00:00:00.000Z",
      gaps: [],
    };
    circular.self = circular;
    await assert.rejects(
      validateResponseTripwire(
        "gaps",
        envelope(circular),
        "/metagraph/gaps.json",
      ),
      ResponseSchemaDriftError,
    );
  });
});

// ── A projection is shorter on purpose (#10975) ─────────────────────────────
//
// `?fields=` returned 500 on EVERY route that advertises it. Measured against
// production before the fix: `?fields=name` gave 500 on gaps, curation,
// candidates, profiles, subnets and providers. Selecting fewer fields is the
// entire point of the parameter, and it was the thing that broke it.
//
// The component describes the whole row, so a projected response is missing
// keys by design. Only ABSENCE is forgiven, and only where the value really is
// missing: a projection can remove a key, it cannot add one and it cannot
// change a type.
describe("the tripwire tolerates a projection, and nothing else", () => {
  const Row = z.object({ netuid: z.int(), name: z.string() }).strict();
  const Envelope = successEnvelopeSchema(
    z.object({ rows: z.array(Row) }).strict(),
  );

  function parse(payload: unknown, projected: boolean) {
    const result = Envelope.safeParse(payload);
    if (result.success) return [];
    return projected
      ? result.error.issues.filter((issue) => {
          let node: unknown = payload;
          for (const key of issue.path)
            node =
              node == null || typeof node !== "object"
                ? undefined
                : (node as Record<PropertyKey, unknown>)[key];
          return node !== undefined;
        })
      : result.error.issues;
  }

  const meta = { contract_version: "x" };

  test("a projected row missing a declared key is accepted", () => {
    const projectedBody = {
      ok: true,
      schema_version: 1,
      data: { rows: [{ name: "root" }] },
      meta,
    };
    assert.deepEqual(parse(projectedBody, true), []);
    // ...and would have been refused without the projection flag, which is
    // exactly the 500 every route was serving.
    assert.equal(parse(projectedBody, false).length > 0, true);
  });

  test("an UNRECOGNIZED key still fails under a projection", () => {
    // A projection can only remove. A key nobody declared is a real drift and
    // forgiving it would give up the guarantee on the responses a caller is
    // most likely to be surprised by.
    const issues = parse(
      {
        ok: true,
        schema_version: 1,
        data: { rows: [{ netuid: 0, name: "root", surprise: "shipped" }] },
        meta,
      },
      true,
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "unrecognized_keys");
  });

  test("a WRONG TYPE on a present value still fails under a projection", () => {
    const issues = parse(
      {
        ok: true,
        schema_version: 1,
        data: { rows: [{ netuid: "zero", name: "root" }] },
        meta,
      },
      true,
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "invalid_type");
  });

  test("a null is present, not absent, and still fails", () => {
    // The distinction the path-walk has to get right: `null` is a VALUE a
    // producer chose, not a field a projection removed.
    const issues = parse(
      {
        ok: true,
        schema_version: 1,
        data: { rows: [{ netuid: null, name: "root" }] },
        meta,
      },
      true,
    );
    assert.equal(issues.length, 1);
  });
});
