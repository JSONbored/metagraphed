// The in-process DATA_API adapter (#13143) honors the service binding's
// contract exactly: whatever workers/data-api.ts answers across the binding,
// the adapter answers in-process, byte for byte. These tests drive BOTH paths
// with the same env and assert the responses are identical — which is the
// adapter's entire job, so it is the whole suite.
//
// The routes chosen touch no store: an unknown path (the dispatcher's 404) and
// a secret-gated write route with its secret unset (the documented 503). The
// data tier's own behavior has its own suites; this one owns only the seam.
import assert from "node:assert/strict";
import { test } from "vitest";
import dataApi from "../workers/data-api.ts";
import { inProcessDataApi } from "../workers/data-api-in-process.ts";
import { mergedDataApiEnv } from "./helpers/worker-env.ts";

const ctx = { waitUntil: () => undefined };

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

test("an unknown path answers identically across the binding and in-process", async () => {
  const env = mergedDataApiEnv();
  const url = "https://data-api.internal/api/v1/no-such-route";
  const direct = await dataApi.fetch(new Request(url), env, ctx);
  const adapted = await inProcessDataApi(env, ctx).fetch(url);
  assert.deepEqual(await snapshot(adapted), await snapshot(direct));
});

test("a secret-gated route with the secret unset answers identically", async () => {
  // ALERT_TRIGGER_CREATE_TOKEN unset: POST /api/v1/alerts/triggers 503s by
  // design (wrangler.data.jsonc's own header documents it) with no store touch.
  const env = mergedDataApiEnv();
  const url = "https://data-api.internal/api/v1/alerts/triggers";
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  };
  const direct = await dataApi.fetch(new Request(url, init), env, ctx);
  const adapted = await inProcessDataApi(env, ctx).fetch(url, init);
  const expected = await snapshot(direct);
  assert.deepEqual(await snapshot(adapted), expected);
  assert.equal(expected.status, 503);
});

test("a Request object passes through with its method and headers intact", async () => {
  // The binding accepts RequestInfo | URL; api.ts mostly forwards the live
  // Request object itself. Same route as above, driven through that form.
  const env = mergedDataApiEnv();
  const request = new Request(
    "https://data-api.internal/api/v1/alerts/triggers",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const direct = await dataApi.fetch(request.clone(), env, ctx);
  const adapted = await inProcessDataApi(env, ctx).fetch(request.clone());
  assert.deepEqual(await snapshot(adapted), await snapshot(direct));
});
