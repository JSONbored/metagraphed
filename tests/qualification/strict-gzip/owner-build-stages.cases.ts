import {
  validateOptionalPgNativeImport,
  optionalProofDiagnosticMarkers,
} from "./optional-pg-import.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_BUILD_STAGES,
  ownerBuildStageFailure,
} from "./owner-build-stages.ts";
for (const [scope, stages] of Object.entries(OWNER_BUILD_STAGES)) {
  test(`fixed ${scope} stage array is immutable`, () =>
    assert.ok(Object.isFrozen(stages)));
  for (const stage of stages)
    test(`failure label ${scope}/${stage} retains only fixed fields`, () => {
      const cause = new Error("private-token-and-path");
      const error = ownerBuildStageFailure(scope, stage, cause) as Error;
      assert.equal(
        error.message,
        `[owner-build-proof-failed:${scope}:${stage}]`,
      );
      assert.equal(error.cause, cause);
      assert.equal(
        ownerBuildStageFailure("raw-build", "builder", error),
        error,
      );
    });
}
test("unknown labels never stringify caller values", () => {
  const target = new Proxy(
    {},
    {
      get() {
        throw new Error("Do not inspect");
      },
    },
  );
  const error = ownerBuildStageFailure(target, target, target) as Error;
  assert.equal(error.message, "[owner-build-proof-failed:unknown:unknown]");
  assert.equal(error.cause, target);
});
test("unknown stages cannot be copied through valid scopes", () => {
  const error = ownerBuildStageFailure(
    "raw-build",
    "private-token",
    null,
  ) as Error;
  assert.equal(error.message, "[owner-build-proof-failed:raw-build:unknown]");
  assert.equal(error.cause, null);
});
test("the stage scope inventory is immutable", () =>
  assert.ok(Object.isFrozen(OWNER_BUILD_STAGES)));

test("optional proof failure remains the same branded error through all surrounding wrappers", () => {
  let failure: unknown;
  try {
    validateOptionalPgNativeImport({} as any);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const markers = optionalProofDiagnosticMarkers(failure);
  assert.equal(markers.split("\n").length, 3);
  for (const [scope, stages] of Object.entries(OWNER_BUILD_STAGES))
    assert.equal(ownerBuildStageFailure(scope, stages[0], failure), failure);
  assert.equal(optionalProofDiagnosticMarkers(failure), markers);
});
