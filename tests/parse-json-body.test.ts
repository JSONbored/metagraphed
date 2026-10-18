import assert from "node:assert/strict";
import { describe, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { ErrorEnvelopeSchema } from "../schemas-src/envelope.ts";
import { handleOgImage } from "../src/og-image.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv, parseJsonBody } from "./row-type.ts";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type RawFetch = (typeof import("../workers/api.ts"))["default"]["fetch"];
type DeployedFetch =
  (typeof import("../workers/api.entry.ts"))["default"]["fetch"];

const errorEnvelope = {
  ok: false,
  schema_version: 1,
  data: null,
  error: { code: "NOT_FOUND", message: "Missing resource" },
  meta: { contract_version: "test" },
};

describe("parseJsonBody", () => {
  test("the dispatcher returns Response for OG matches and a declined path", async () => {
    expectTypeOf<
      IsAny<Awaited<ReturnType<typeof handleRequest>>>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Awaited<ReturnType<typeof handleRequest>>
    >().toEqualTypeOf<Response>();
    expectTypeOf<Awaited<ReturnType<RawFetch>>>().toEqualTypeOf<Response>();
    expectTypeOf<Awaited<ReturnType<DeployedFetch>>>().toEqualTypeOf<Response>();
    expectTypeOf<Awaited<ReturnType<typeof handleOgImage>>>().toEqualTypeOf<
      Response | null
    >();

    vi.stubGlobal("caches", undefined);
    const env = mockEnv();
    for (const path of ["/og", "/og.png"]) {
      const response = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`, { method: "HEAD" }),
        env,
        {},
      );
      assert.ok(response instanceof Response);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(await response.text(), "");
    }

    const response = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/dispatch-type-probe"),
      env,
      {},
    );
    assert.equal(response.status, 404);
    const rawBody = await response.clone().json();
    // @ts-expect-error unvalidated response JSON cannot be read as an envelope
    assert.equal(rawBody.ok, false);
    const body = await parseJsonBody(response, ErrorEnvelopeSchema);
    assert.equal(body.error.code, "not_found");
  });

  test("validates and infers a canonical response, consuming the body once", async () => {
    const response = new Response(JSON.stringify(errorEnvelope));
    const body = await parseJsonBody(response, ErrorEnvelopeSchema);

    const code: string = body.error.code;
    const ok: false = body.ok;
    assert.equal(code, "NOT_FOUND");
    assert.equal(ok, false);
    assert.deepEqual(body, errorEnvelope);
    assert.equal(response.bodyUsed, true);

    // These also run under the root typecheck: returning any would make the
    // expected errors unused and fail compilation (#11589).
    // @ts-expect-error reading a typed body requires a schema
    const withoutSchema: (res: Response) => Promise<unknown> = parseJsonBody;
    // @ts-expect-error the canonical error code is a string
    const numericCode: number = body.error.code;
    // @ts-expect-error the canonical error object has no invented property
    const invented = body.error.invented;
    assert.equal(withoutSchema, parseJsonBody);
    assert.equal(numericCode, "NOT_FOUND");
    assert.equal(invented, undefined);
  });

  test("rejects bodies that violate the canonical response schema", async () => {
    for (const body of [
      { ...errorEnvelope, ok: true },
      { ...errorEnvelope, error: { code: 404, message: "Missing resource" } },
      { ...errorEnvelope, invented: true },
    ]) {
      await assert.rejects(
        parseJsonBody(new Response(JSON.stringify(body)), ErrorEnvelopeSchema),
        z.ZodError,
      );
    }
  });

  test("propagates malformed JSON and consumed-body errors", async () => {
    await assert.rejects(
      parseJsonBody(new Response("{"), ErrorEnvelopeSchema),
      SyntaxError,
    );
    const response = new Response(JSON.stringify(errorEnvelope));
    await response.text();
    await assert.rejects(parseJsonBody(response, ErrorEnvelopeSchema), TypeError);
  });

  test("infers transformed output and supports async schemas", async () => {
    const length = await parseJsonBody(
      new Response('"abc"'),
      z.string().transform(async (value) => value.length),
    );
    const asNumber: number = length;
    assert.equal(asNumber, 3);
    // @ts-expect-error schema output is a number, not the string input
    const asInput: string = length;
    assert.equal(asInput, 3);
  });
});
