import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createComponentValidatorCompiler } from "../scripts/lib/component-validator.ts";

describe("createComponentValidatorCompiler", () => {
  test("memoizes ajv.compile by schema_ref (#2093)", () => {
    let compileCount = 0;
    const ajv = {
      compile(schema) {
        compileCount += 1;
        void schema;
        return () => true;
      },
    };
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
