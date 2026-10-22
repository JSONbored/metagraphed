import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { beforeAll, describe, test } from "vitest";
import { X402PaymentRequiredSchema } from "../schemas-src/x402.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";
import {
  API_ROUTES,
  buildOpenApiArtifact,
  networkVariantPath,
} from "../src/contracts.ts";
import { paymentRequiredResponse, type X402Config } from "../src/x402.ts";
import {
  X402_REQUIRED_HEADER,
  X402_RESPONSE_HEADER,
  X402_SIGNATURE_HEADER,
} from "../src/x402-headers.ts";
import { x402PriceFor, x402RequiresPayment } from "../src/x402-pricing.ts";
import { requiredHeader, type Row } from "./row-type.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const GENERATED_AT = "1970-01-01T00:00:00.000Z";

describe("canonical x402 OpenAPI contract", () => {
  let openapi: Row;

  // Generate the canonical document once; parallel coverage can exceed the
  // default 10-second hook budget while generating the full schema registry.
  beforeAll(async () => {
    openapi = buildOpenApiArtifact(
      GENERATED_AT,
      await loadOpenApiComponentSchemas(GENERATED_AT),
    );
  }, 60_000);

  test("covers every payable operation and its network variants from concrete route policy", () => {
    let optional = 0;
    let required = 0;
    for (const route of API_ROUTES) {
      // Runtime requests carry values, rather than route placeholders. In
      // particular, subnet pricing requires a numeric netuid, so the old
      // x402PriceFor(route.path) silently omitted payable subnet operations.
      const concretePath = route.path.replace(/\{[^}]+\}/g, "1");
      const price = x402PriceFor(concretePath);
      const paymentRequired = x402RequiresPayment(concretePath);
      if (price) {
        if (paymentRequired) required += 1;
        else optional += 1;
      }
      for (const path of [route.path, networkVariantPath(route.path)]) {
        if (!path) continue;
        const operation = openapi.paths[path][route.method.toLowerCase()];
        const paymentParameter = operation.parameters.find(
          (parameter: Row) => parameter.name === X402_SIGNATURE_HEADER,
        );
        const response = operation.responses["402"];
        const replay = operation.responses["409"];
        const unavailable = operation.responses["503"];
        const receipt =
          operation.responses["200"].headers[X402_RESPONSE_HEADER];
        if (!price) {
          assert.equal(response, undefined, path);
          assert.equal(replay, undefined, path);
          assert.equal(unavailable, undefined, path);
          assert.equal(paymentParameter, undefined, path);
          assert.equal(receipt, undefined, path);
          continue;
        }
        assert.equal(paymentParameter.in, "header", path);
        assert.equal(paymentParameter.required, false, path);
        assert.equal(paymentParameter.schema.contentEncoding, "base64", path);
        assert.equal(
          response.content["application/json"].schema.$ref,
          "#/components/schemas/X402PaymentRequired",
          path,
        );
        assert.equal(
          response.headers[X402_REQUIRED_HEADER].$ref,
          "#/components/headers/X402PaymentRequired",
          path,
        );
        assert.equal(
          receipt.$ref,
          "#/components/headers/X402PaymentResponse",
          path,
        );
        for (const refusal of [replay, unavailable]) {
          assert.equal(
            refusal.content["application/json"].schema.$ref,
            "#/components/schemas/ErrorEnvelope",
            path,
          );
          assert.equal(refusal.headers[X402_REQUIRED_HEADER], undefined, path);
          assert.equal(
            refusal.headers[X402_RESPONSE_HEADER].$ref,
            "#/components/headers/X402PaymentResponse",
            path,
          );
        }
        assert.match(replay.description, /x402_payment_consumed/, path);
        assert.match(replay.description, /x402_payment_conflict/, path);
        assert.match(unavailable.description, /x402_settlement_pending/, path);
        assert.match(unavailable.description, /x402_unavailable/, path);
        assert.equal(
          unavailable.headers["retry-after"].$ref,
          "#/components/headers/X402RetryAfter",
          path,
        );
        assert.match(
          response.description,
          paymentRequired ? /Payment is required/ : /Payment is optional/,
          path,
        );
      }
    }
    assert.ok(optional > 0, "optional-payment operations must be exercised");
    assert.ok(required > 0, "required-payment operations must be exercised");

    // Positive controls protect the numeric-template regression and the
    // distinction between an unpaid export and an anonymous ordinary read.
    for (const path of [
      "/api/v1/subnets/{netuid}/ownership-history",
      "/api/v1/subnets/{netuid}/conviction",
      "/api/v1/subnets/{netuid}/lease",
      "/api/v1/blocks",
      "/api/v1/ask",
    ]) {
      const method = path === "/api/v1/ask" ? "post" : "get";
      assert.match(
        openapi.paths[path][method].responses["402"].description,
        /Requests without payment use anonymous limits/,
        path,
      );
    }
    assert.match(
      openapi.paths["/api/v1/export/chain-events"].get.responses["402"]
        .description,
      /Requests without payment and rejected payments/,
    );
    assert.doesNotMatch(
      openapi.info.description,
      /every operation is an unauthenticated GET/i,
    );
  });

  test("pending settlements retry the same payment and consumed payments do not repeat work", () => {
    const responses =
      openapi.paths["/api/v1/export/chain-events"].get.responses;
    assert.match(
      responses["503"].description,
      /retry the identical HTTP request with the identical PAYMENT-SIGNATURE/,
    );
    assert.match(responses["503"].description, /do not create a new payment/);
    assert.match(responses["503"].description, /retry: same_payment_payload/);
    assert.match(
      responses["503"].headers[X402_RESPONSE_HEADER].description,
      /not confirmation that settlement completed/,
    );
    assert.match(
      responses["409"].description,
      /without repeating the paid operation/,
    );
    assert.match(
      responses["409"].headers[X402_RESPONSE_HEADER].description,
      /Omitted for x402_payment_conflict/,
    );
    assert.equal(openapi.components.headers.X402RetryAfter.example, 5);
    assert.equal(
      openapi.components.headers.X402RetryAfter.schema.type,
      "integer",
    );
  });

  test("the published quote schema validates the actual direct body and base64 header", async () => {
    const config: X402Config = {
      facilitatorUrl: "https://facilitator.example",
      legs: [
        {
          network: "eip155:8453",
          networkLabel: "Base",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
          extra: { name: "USD Coin", version: "2" },
        },
        {
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          networkLabel: "Solana",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: "11111111111111111111111111111111",
          extra: { feePayer: "11111111111111111111111111111111" },
        },
      ],
    };
    const request = new Request(
      "https://api.metagraph.sh/api/v1/export/chain-events?start=1&end=2",
    );
    const response = await paymentRequiredResponse(
      config,
      request,
      "24000",
      "metagraphed export call — schema check",
    );
    assert.equal(response.status, 402);
    const body: unknown = await response.json();
    const quote = X402PaymentRequiredSchema.parse(body);
    assert.equal(quote.x402Version, 2);
    assert.equal(quote.resource.url, request.url);
    assert.equal(quote.resource.mimeType, "application/json");
    assert.equal(quote.accepts.length, 2);
    assert.equal(quote.accepts[0]!.scheme, "exact");
    assert.equal(quote.accepts[0]!.amount, "24000");
    assert.equal(
      quote.accepts[1]!.extra.feePayer,
      config.legs[1]!.extra.feePayer,
    );
    assert.deepEqual(quote.extensions, {});
    const decodedHeader: unknown = JSON.parse(
      Buffer.from(
        requiredHeader(response, X402_REQUIRED_HEADER),
        "base64",
      ).toString("utf8"),
    );
    assert.deepEqual(decodedHeader, body);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      components: openapi.components,
      $ref: "#/components/schemas/X402PaymentRequired",
    });
    assert.equal(validate(body), true, ajv.errorsText(validate.errors));
    const invalidQuotes = [
      { ...quote, x402Version: 1 },
      { ...quote, accepts: undefined },
      { ...quote, extensions: { unexpected: true } },
      { ...quote, accepts: [{ ...quote.accepts[0], amount: "0.024" }] },
      { ...quote, accepts: [{ ...quote.accepts[0], extra: { feePayer: 1 } }] },
      {
        ok: false,
        schema_version: 1,
        data: null,
        error: { code: "payment_required", message: "Payment required" },
        meta: {},
      },
    ];
    for (const invalid of invalidQuotes) {
      assert.equal(X402PaymentRequiredSchema.safeParse(invalid).success, false);
      assert.equal(validate(invalid), false);
    }
    const quoteHeader = openapi.components.headers.X402PaymentRequired;
    assert.equal(quoteHeader.schema.contentEncoding, "base64");
    assert.equal(
      quoteHeader.schema.contentSchema.$ref,
      "#/components/schemas/X402PaymentRequired",
    );
  });
});
