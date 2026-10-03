import assert from "node:assert/strict";
import { test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { generateOpenApiZodComponents } from "../scripts/generate-openapi-zod-components.ts";
import { NativeRuntimeRequestSchema } from "../schemas-src/routes/native-runtime.ts";

test("native recursive JSON has one named component and validates real nested values in OpenAPI", () => {
  const schemas = generateOpenApiZodComponents();
  assert.ok(schemas.NativeJsonValue);
  assert.equal(schemas.__shared, undefined);
  const validate = new Ajv2020({
    strict: false,
    strictNumbers: true,
    validateFormats: false,
  }).compile({
    components: { schemas },
    $ref: "#/components/schemas/NativeRuntimeRequest",
  });
  const input = NativeRuntimeRequestSchema.parse({
    operations: [
      {
        kind: "prepare",
        pallet: "SubtensorModule",
        member: "fixture",
        args: [
          null,
          true,
          "18446744073709551615",
          19,
          [1, "2"],
          {
            variant: "Some",
            fields: { amount: "9007199254740993", bytes: "0x1234" },
          },
        ],
      },
    ],
  });
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...input,
      operations: [{ ...input.operations[0], args: [undefined] }],
    }),
    false,
  );
  assert.equal(
    validate({
      ...input,
      operations: [{ ...input.operations[0], args: [NaN] }],
    }),
    false,
  );
});
