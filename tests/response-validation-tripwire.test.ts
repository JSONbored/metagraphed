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
import { afterEach, describe, test, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import {
  isProjectedAway,
  ResponseSchemaDriftError,
  validateResponseTripwire,
} from "../src/response-validation-tripwire.ts";
import { COMPONENT_SCHEMAS_BY_ID } from "../schemas-src/openapi-registry.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../scripts/lib.ts";
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
  // Drives the REAL validateResponseTripwire rather than a local copy of its
  // filter: a test that reimplements the logic it is checking passes on its
  // own reasoning, which is the one thing it must not do.
  const envelope = (gaps: unknown[]) => ({
    ok: true,
    schema_version: 1,
    data: {
      schema_version: 1,
      generated_at: "2026-08-13T00:00:00.000Z",
      gaps,
    },
    meta: { contract_version: "x" },
  });
  const PATH = "/metagraph/gaps.json";

  test("a projected row missing declared keys is accepted", async () => {
    // `?fields=name` serves exactly this, and it was a 500 on every route
    // that advertises the parameter.
    await assert.doesNotReject(
      validateResponseTripwire(
        "gaps",
        envelope([{ name: "root" }]),
        PATH,
        true,
      ),
    );
  });

  test("...and is still refused when no projection was requested", async () => {
    // Guards the guard: if the flag stopped being read, the test above would
    // pass for the wrong reason.
    await assert.rejects(
      validateResponseTripwire(
        "gaps",
        envelope([{ name: "root" }]),
        PATH,
        false,
      ),
      ResponseSchemaDriftError,
    );
  });

  test("an UNRECOGNIZED key still fails under a projection", async () => {
    // A projection can only remove. Forgiving an undeclared key would give up
    // the guarantee on the responses a caller is most likely to be surprised
    // by.
    await assert.rejects(
      validateResponseTripwire(
        "gaps",
        envelope([{ name: "root", surprise: "shipped" }]),
        PATH,
        true,
      ),
      ResponseSchemaDriftError,
    );
  });

  test("a WRONG TYPE on a present value still fails under a projection", async () => {
    await assert.rejects(
      validateResponseTripwire(
        "gaps",
        envelope([{ netuid: "zero", name: "root" }]),
        PATH,
        true,
      ),
      ResponseSchemaDriftError,
    );
  });

  test("a scalar where an object is declared still fails", async () => {
    // The path cannot be walked into a string, so the issue is NOT explained
    // by the projection — a row that is not a row is a real drift, and
    // forgiving it would be the worst possible reading of "shorter on
    // purpose".
    await assert.rejects(
      validateResponseTripwire("gaps", envelope(["not-an-object"]), PATH, true),
      ResponseSchemaDriftError,
    );
  });

  test("a null is present, not absent, and still fails", async () => {
    // The distinction the path-walk has to get right: `null` is a value the
    // producer CHOSE, not a field the projection removed.
    await assert.rejects(
      validateResponseTripwire(
        "gaps",
        envelope([{ netuid: null, name: "root" }]),
        PATH,
        true,
      ),
      ResponseSchemaDriftError,
    );
  });
});

describe("isProjectedAway walks the path, and stops when it cannot", () => {
  test("a key the payload does not carry reads as projected away", () => {
    assert.equal(isProjectedAway({ a: { b: {} } }, ["a", "b", "c"]), true);
  });

  test("a key the payload does carry does not", () => {
    assert.equal(
      isProjectedAway({ a: { b: { c: 1 } } }, ["a", "b", "c"]),
      false,
    );
  });

  test("null is a value, not an absence", () => {
    assert.equal(isProjectedAway({ a: null }, ["a"]), false);
  });

  test("a path that descends THROUGH a scalar is not projected away", () => {
    // Unreachable via a real Zod issue -- Zod reports at the level that failed
    // and never emits a path descending through a scalar -- so this is the
    // only way to prove the guard fires. Getting it wrong would forgive a real
    // drift, which is the one thing this function must never do.
    assert.equal(isProjectedAway({ a: "scalar" }, ["a", "b"]), false);
    assert.equal(isProjectedAway({ a: null }, ["a", "b"]), false);
  });
});

// The projection tolerance above is proven at the unit; these prove the
// WIRING, which is the half that actually broke: #10975 was not a filter bug,
// it was every list route passing `projected=false` because nothing passed
// anything. A unit-green filter and a call site that never sets the flag give
// exactly the production behaviour this repo shipped.
describe("the projection signal reaches the tripwire from the routes", () => {
  test("flag on: EVERY route publishing `fields` answers 200 with it", async () => {
    // DERIVED from the published document, not a hand-list: a route that
    // starts publishing `fields` tomorrow is covered the moment it appears.
    // The pre-#10975 suite named several of the broken routes and stayed green
    // throughout, because it never sent the parameter -- the gap is the
    // parameter, not the route.
    //
    // Templated paths are excluded because the tripwire cannot resolve them at
    // all yet (#10965) -- including them would assert a 200 that proves
    // nothing.
    const spec = JSON.parse(
      readFileSync(
        path.join(repoRoot, "public/metagraph/openapi.json"),
        "utf8",
      ),
    ) as Row;
    const routes = Object.entries(spec.paths as Record<string, Row>)
      .filter(([route]) => !route.includes("{"))
      .filter(([, ops]) =>
        Object.values(ops as Record<string, Row>).some((op) =>
          (op?.parameters as Row[] | undefined)?.some(
            (param) => param?.name === "fields",
          ),
        ),
      )
      .map(([route]) => route);
    assert.ok(
      routes.length >= 25,
      `expected the fields surface, saw ${routes.length}`,
    );

    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "true";
    const drifted: string[] = [];
    for (const route of routes) {
      const base = await handleRequest(
        req(`${route}?limit=1`),
        env as unknown as Env,
        {},
      );
      if (base.status !== 200) continue;
      const body = (await base.json()) as Row;
      // Any array of objects under `data` is a projectable collection; the
      // first of its keys is a field the route certainly serves.
      const rows = Object.values((body.data ?? {}) as Record<string, unknown>)
        .filter(
          (value): value is Row[] =>
            Array.isArray(value) &&
            value.length > 0 &&
            typeof value[0] === "object" &&
            value[0] !== null,
        )
        .at(0);
      const field = rows && Object.keys(rows[0])[0];
      if (!field) continue;
      const res = await handleRequest(
        req(`${route}?limit=1&fields=${field}`),
        env as unknown as Env,
        {},
      );
      // A 400 is the route declining the field name, not a drift -- two routes
      // project a collection this generic pick does not land on. A 500 is the
      // regression.
      if (res.status >= 500) drifted.push(`${route}?fields=${field}`);
    }
    assert.deepEqual(drifted, []);
  });

  test("flag on: a `?sections=` request answers 200 on a TEMPLATED route", async () => {
    // The two halves of this change, proven inseparable: passing the TEMPLATE
    // makes these routes resolvable at all (#10965), and the sections signal
    // is what keeps that from turning `?sections=` into a 500 (#10960).
    // Reverting the signal alone fails exactly this test.
    const env = createLocalArtifactEnv() as Row;
    env.METAGRAPH_VALIDATE_RESPONSES = "true";
    for (const path of [
      "/api/v1/subnets/1?sections=economics",
      "/api/v1/subnets/1/profile?sections=profile",
    ]) {
      const res = await handleRequest(req(path), env as unknown as Env, {});
      assert.equal(res.status, 200, `${path} did not answer 200`);
    }
  });

  test("flag on: a TEMPLATED route's drift detection is really on now", async () => {
    // The other half of #10965: resolvable must mean ENFORCED, or the fix is
    // cosmetic. The same projected body that the sections signal forgives is
    // still a drift when nothing was projected.
    const env = createLocalArtifactEnv() as Row;
    const res = await handleRequest(
      req("/api/v1/subnets/1?sections=economics"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    for (const required of ["subnet", "surfaces", "gaps"]) {
      assert.ok(
        !((body.data as Row) ?? {})[required],
        `${required} should have been projected away`,
      );
    }
    const artifact = "/metagraph/subnets/{netuid}.json";
    await assert.rejects(
      () => validateResponseTripwire("subnet-detail", body, artifact, false),
      ResponseSchemaDriftError,
    );
    await assert.doesNotReject(
      validateResponseTripwire("subnet-detail", body, artifact, true),
    );
  });
});
