import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  expectedVariantSource,
  failurePhase,
  phaseBytes,
  FAILURE_PHASES,
} from "./failure-variants.ts";
import {
  FAILURE_LIFECYCLE_SOURCE_PINS,
  FAILURE_LIFECYCLE_ACTIVE_PATHS,
  instrumentFailureLifecycleSource,
  type FailureLifecycleSourcePath,
} from "./failure-lifecycle-source.ts";
const entries = JSON.parse(
  readFileSync(
    new URL("./failure-lifecycle-source-fixtures.json", import.meta.url),
    "utf8",
  ),
).entries as {
  logical: FailureLifecycleSourcePath;
  variant: "fixed" | "unfixed";
  source: string;
}[];
for (const phase of FAILURE_PHASES)
  test(`exact closed phase data: ${phase}`, () => {
    assert.equal(failurePhase(phase), phase);
    assert.deepEqual(JSON.parse(phaseBytes(phase).toString()), { phase });
  });
for (const phase of [
  undefined,
  null,
  "",
  "fixed",
  "negative",
  1,
  true,
  {},
  ["instrumented"],
])
  test(`refuses unrecognized phase ${typeof phase}/${String(phase)}`, () =>
    assert.throws(() => failurePhase(phase)));
for (const logical of FAILURE_LIFECYCLE_ACTIVE_PATHS) {
  const current = entries.find(
    (e) => e.logical === logical && e.variant === "fixed",
  )!.source;
  const prior =
    FAILURE_LIFECYCLE_SOURCE_PINS[logical].fixed ===
    FAILURE_LIFECYCLE_SOURCE_PINS[logical].unfixed
      ? current
      : entries.find((e) => e.logical === logical && e.variant === "unfixed")!
          .source;
  test(`uninstrumented bytes preserved: ${logical}`, () =>
    assert.equal(
      expectedVariantSource(logical, current, "uninstrumented"),
      current,
    ));
  test(`fixed exact instrumented bytes: ${logical}`, () =>
    assert.equal(
      expectedVariantSource(logical, current, "instrumented"),
      instrumentFailureLifecycleSource(logical, current, "fixed").source,
    ));
  test(`unfixed exact instrumented bytes: ${logical}`, () =>
    assert.equal(
      expectedVariantSource(logical, current, "unfixed-instrumented", prior),
      instrumentFailureLifecycleSource(logical, prior, "unfixed").source,
    ));
  test(`changed reference refused: ${logical}`, () =>
    assert.throws(() =>
      expectedVariantSource(logical, current + "\n", "instrumented"),
    ));
  if (
    logical !== "src/strict-gzip-reader.ts" &&
    logical !== "workers/data-api.ts"
  ) {
    test(`unfixed missing parent refused: ${logical}`, () =>
      assert.throws(() =>
        expectedVariantSource(logical, current, "unfixed-instrumented"),
      ));
    test(`unfixed wrong parent refused: ${logical}`, () =>
      assert.throws(() =>
        expectedVariantSource(
          logical,
          current,
          "unfixed-instrumented",
          current,
        ),
      ));
  }
}
