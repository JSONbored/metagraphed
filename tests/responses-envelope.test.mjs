import assert from "node:assert/strict";
import { test } from "vitest";
import { dataResponse, envelopeResponse } from "../workers/responses.mjs";
import { errorResponse, ifNoneMatchSatisfied } from "../workers/http.mjs";

const reqWith = (ifNoneMatch) =>
  new Request("https://metagraph.sh/api/v1/anything", {
    headers: ifNoneMatch == null ? {} : { "if-none-match": ifNoneMatch },
  });

// Regression guard: the two success builders (dataResponse + envelopeResponse)
// must emit the identical SuccessEnvelope shape. dataResponse previously added an
// `error: null` key that violated the additionalProperties:false SuccessEnvelope
// schema and diverged from envelopeResponse.
test("dataResponse emits the SuccessEnvelope shape with no error key", async () => {
  const response = dataResponse({}, { hello: "world" }, 200, {
    source: "test",
  });
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), [
    "data",
    "meta",
    "ok",
    "schema_version",
  ]);
  assert.equal("error" in body, false);
  assert.equal(body.ok, true);
  assert.equal(body.schema_version, 1);
  assert.deepEqual(body.data, { hello: "world" });
  assert.equal(body.meta.source, "test");
});

// Error envelopes must not be cached by shared/edge caches — a transient 5xx or
// a not-yet-published 404 would otherwise be served stale from the CDN.
test("errorResponse is cache-control: no-store across 4xx and 5xx", async () => {
  for (const status of [400, 404, 500, 503]) {
    const res = errorResponse("some_error", "boom", status);
    assert.equal(res.status, status);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-metagraph-cache-profile"), "no-store");
    assert.equal(res.headers.get("x-metagraph-error-code"), "some_error");
  }
});

// ifNoneMatchSatisfied implements the RFC 7232 §3.2 precondition that backs every
// 304 short-circuit (live envelopes, raw artifacts, and the edge/overlay caches).
const ETAG = 'W/"abc123"';

test("ifNoneMatchSatisfied: exact weak-tag echo matches", () => {
  assert.equal(ifNoneMatchSatisfied(reqWith(ETAG), ETAG), true);
});

test("ifNoneMatchSatisfied: weak/strong validators compare equal", () => {
  // If-None-Match uses the weak comparison, so the W/ prefix is ignored.
  assert.equal(ifNoneMatchSatisfied(reqWith('"abc123"'), ETAG), true);
  assert.equal(ifNoneMatchSatisfied(reqWith(ETAG), '"abc123"'), true);
});

test("ifNoneMatchSatisfied: the * form matches any current representation", () => {
  assert.equal(ifNoneMatchSatisfied(reqWith("*"), ETAG), true);
  // ...but only when a representation exists (there is a current etag).
  assert.equal(ifNoneMatchSatisfied(reqWith("*"), null), false);
});

test("ifNoneMatchSatisfied: matches any tag in a comma-separated list", () => {
  assert.equal(ifNoneMatchSatisfied(reqWith(`"x", ${ETAG}, "y"`), ETAG), true);
  assert.equal(ifNoneMatchSatisfied(reqWith('"x", "y"'), ETAG), false);
});

test("ifNoneMatchSatisfied: no header or no etag is a miss", () => {
  assert.equal(ifNoneMatchSatisfied(reqWith(null), ETAG), false);
  assert.equal(ifNoneMatchSatisfied(reqWith(ETAG), null), false);
});

// envelopeResponse owns the response shape (the helper tests own the match
// logic): a match is a bodiless 304 keeping the etag; a miss is a 200 with body.
test("envelopeResponse: a match returns a bodiless 304, a miss returns the body", async () => {
  const payload = { data: { hello: "world" }, meta: { contract_version: "x" } };
  const fresh = await envelopeResponse(reqWith(null), payload, "standard");
  const etag = fresh.headers.get("etag");
  assert.equal(fresh.status, 200);
  assert.ok(etag);

  const matched = await envelopeResponse(reqWith(etag), payload, "standard");
  assert.equal(matched.status, 304);
  assert.equal(await matched.text(), "");
  assert.equal(matched.headers.get("etag"), etag);

  const stale = await envelopeResponse(reqWith('"stale"'), payload, "standard");
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).data.hello, "world");
});
