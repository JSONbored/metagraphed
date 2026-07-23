import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Ajv2020 } from "ajv/dist/2020.js";
import { createComponentValidatorCompiler } from "../scripts/lib/component-validator.ts";

describe("createComponentValidatorCompiler", () => {
  test("memoizes ajv.compile by schema_ref (#2093)", () => {
    let compileCount = 0;
    const ajv = {
      compile(schema: unknown) {
        compileCount += 1;
        void schema;
        return () => true;
      },
    } as unknown as Ajv2020;
    const compile = createComponentValidatorCompiler(ajv);

    const refA = "#/components/schemas/SubnetDetail";
    const refB = "#/components/schemas/ProviderDetail";
    const validatorA1 = compile(refA);
    const validatorA2 = compile(refA);
    const validatorB = compile(refB);

    assert.equal(compileCount, 2);
    assert.equal(validatorA1, validatorA2);
    assert.notEqual(validatorA1, validatorB);
  });
});
