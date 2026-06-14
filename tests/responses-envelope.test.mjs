import assert from "node:assert/strict";
import { test } from "vitest";
import { dataResponse } from "../workers/responses.mjs";

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
