// The tripwire conformance sweep's decision rule (#11046), tested without a
// network -- same discipline as check-response-conformance's suite: every skip
// is a decision (the seam itself never audits a non-200 or non-JSON answer),
// and the one thing the sweep must never forgive is a body the audit seam's
// own validation refuses.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { evaluateRoute } from "../scripts/check-tripwire-conformance.ts";

/** The tao-usd route row, as API_ROUTES declares it -- the same subject the
 * audit suite pins, so a drift here reads identically to the production
 * fingerprint #11079 dispositioned. */
const TAO_USD_ROUTE = {
  id: "tao-usd",
  path: "/api/v1/network/tao-usd",
  artifact_path: "/metagraph/network/tao-usd.json",
};

/** A minimal body the TaoUsd component accepts whole: an unwritten series. */
const VALID_BODY = {
  ok: true,
  schema_version: 1,
  data: {
    schema_version: 1,
    window: "24h",
    point_count: 0,
    stale: true,
    stale_after_ms: 0,
    age_ms: null,
    priced_point_count: 0,
    latest: null,
    oldest_observed_at: null,
    change_usd: null,
    change_pct: null,
    points: [],
  },
  meta: {
    artifact_path: "/metagraph/network/tao-usd.json",
    contract_version: "2026-08-13",
  },
};

const respond = (body: unknown, init: ResponseInit = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    })) as unknown as typeof fetch;

describe("evaluateRoute (#11046)", () => {
  test("a 200 JSON body its component accepts is clean", async () => {
    const verdict = await evaluateRoute(TAO_USD_ROUTE, respond(VALID_BODY));
    assert.deepEqual(verdict, { kind: "clean" });
  });

  test("a body the seam's validation refuses is the finding, with its detail", async () => {
    const drifted = structuredClone(VALID_BODY) as Record<string, unknown>;
    delete (drifted.data as Record<string, unknown>).points;
    const verdict = await evaluateRoute(TAO_USD_ROUTE, respond(drifted));
    assert.equal(verdict.kind, "drift");
    // The detail names the path, so the report is actionable without a rerun.
    assert.match((verdict as { detail: string }).detail, /points/);
  });

  test("a non-200 answer is a skip carrying the status, never a drift", async () => {
    const verdict = await evaluateRoute(
      TAO_USD_ROUTE,
      (async () =>
        new Response("nope", { status: 503 })) as unknown as typeof fetch,
    );
    assert.deepEqual(verdict, { kind: "skip", reason: "503" });
  });

  test("a 200 that is not JSON is a skip -- the seam never audits it either", async () => {
    const verdict = await evaluateRoute(
      TAO_USD_ROUTE,
      (async () =>
        new Response("<xml/>", {
          status: 200,
          headers: { "content-type": "application/xml" },
        })) as unknown as typeof fetch,
    );
    assert.deepEqual(verdict, { kind: "skip", reason: "200" });
  });

  test("a route with an unfixtured parameter is skipped, never fetched", async () => {
    let fetched = false;
    const verdict = await evaluateRoute(
      {
        id: "x",
        path: "/api/v1/x/{no_such_subject}",
        artifact_path: "/x.json",
      },
      (async () => {
        fetched = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    );
    assert.deepEqual(verdict, { kind: "skip", reason: "no subject" });
    assert.equal(fetched, false);
  });
});
