import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  instrumentFailureLifecycleSource,
  verifyFailureLifecycleTransform,
  FAILURE_LIFECYCLE_SOURCE_PINS,
  FAILURE_LIFECYCLE_ACTIVE_PATHS,
  FAILURE_LIFECYCLE_UNFIXED_PATHS,
  FAILURE_LIFECYCLE_PURE_ONLY_PATHS,
  type FailureLifecycleSourcePath,
} from "./failure-lifecycle-source.ts";
const fixtures = JSON.parse(
  readFileSync(
    new URL("./failure-lifecycle-source-fixtures.json", import.meta.url),
    "utf8",
  ),
).entries as {
  logical: FailureLifecycleSourcePath;
  variant: "fixed" | "unfixed";
  source: string;
}[];
for (const fixture of fixtures) {
  test(`exact supplemental transform preserves every original byte: ${fixture.logical}/${fixture.variant}`, () => {
    const result = instrumentFailureLifecycleSource(
      fixture.logical,
      fixture.source,
      fixture.variant,
    );
    assert.equal(
      result.proof.originalSha256,
      FAILURE_LIFECYCLE_SOURCE_PINS[fixture.logical][fixture.variant],
    );
    assert.notEqual(
      result.proof.originalSha256,
      result.proof.instrumentedSha256,
    );
    assert.ok(result.proof.instrumentedBytes > result.proof.originalBytes);
    assert.deepEqual(
      verifyFailureLifecycleTransform(
        fixture.logical,
        fixture.source,
        result.source,
        fixture.variant,
      ),
      result.proof,
    );
    let recovered = result.source.replace(result.proof.importLine, "");
    for (const edit of result.proof.edits)
      recovered = recovered.replace(edit.insertion, "");
    assert.equal(recovered, fixture.source);
    assert.doesNotMatch(result.proof.importLine, /from ["']pg["']/);
  });
  test(`changed source cannot acquire instrumentation proof: ${fixture.logical}/${fixture.variant}`, () => {
    assert.throws(() =>
      instrumentFailureLifecycleSource(
        fixture.logical,
        fixture.source + "\n",
        fixture.variant,
      ),
    );
  });
  test(`altered transformed output cannot acquire proof: ${fixture.logical}/${fixture.variant}`, () => {
    const result = instrumentFailureLifecycleSource(
      fixture.logical,
      fixture.source,
      fixture.variant,
    );
    assert.throws(() =>
      verifyFailureLifecycleTransform(
        fixture.logical,
        fixture.source,
        result.source + "\n",
        fixture.variant,
      ),
    );
  });
}
test("unfixed source control preserves actual connect-before-finally defect", () => {
  for (const fixture of fixtures.filter((row) => row.variant === "unfixed")) {
    const result = instrumentFailureLifecycleSource(
      fixture.logical,
      fixture.source,
      "unfixed",
    );
    assert.match(
      result.source,
      /observeFailurePgClient\(client, Client, "[A-Za-z]+"\);\n    await client\.connect\(\);\n    try \{/,
    );
    assert.throws(() =>
      instrumentFailureLifecycleSource(
        fixture.logical,
        fixture.source,
        "fixed",
      ),
    );
  }
});
test("fixed source control retains actual connect inside try/finally", () => {
  for (const fixture of fixtures.filter(
    (row) =>
      row.variant === "fixed" &&
      row.logical !== "workers/data-api.ts" &&
      row.logical !== "src/strict-gzip-reader.ts",
  )) {
    const result = instrumentFailureLifecycleSource(
      fixture.logical,
      fixture.source,
    );
    assert.match(
      result.source,
      /observeFailurePgClient\(client, Client, "[A-Za-z]+"\);\n    try \{\n      await client\.connect\(\);/,
    );
  }
});
test("all source transformations have a closed fixed path inventory", () => {
  assert.equal(Object.keys(FAILURE_LIFECYCLE_SOURCE_PINS).length, 5);
  assert.throws(() =>
    instrumentFailureLifecycleSource(
      "node_modules/pg/lib/client.js" as any,
      "arbitrary",
    ),
  );
  assert.throws(() =>
    instrumentFailureLifecycleSource(
      "src/pg-sql.ts",
      fixtures[0]!.source,
      "other" as any,
    ),
  );
});
test("owner loop hooks count writer calls explicitly and observe exact byte views", () => {
  const fixture = fixtures.find(
    (row) => row.logical === "workers/data-api.ts",
  )!;
  const result = instrumentFailureLifecycleSource(
    fixture.logical,
    fixture.source,
  );
  assert.match(
    result.source,
    /for \(const message of batch.messages\) \{\n      observeFailureMessage\(message.id, message.body\);/,
  );
  assert.match(
    result.source,
    /observeFailureWriter\(message.id\);\n        await writeSyncBatch\(body, writers, Date.now\(\), familyWriters\);/,
  );
  assert.match(
    result.source,
    /beginFailureLifecycleFromEnv\(env\);\n    try \{/,
  );
  assert.match(
    result.source,
    /finally \{\n      finishFailureLifecycle\(\);\n    \}\n  \},\n\};\n$/,
  );
  assert.equal(result.proof.edits.length, 5);
});

test("active queue variants include actual lane-health clients and leave read-store unchanged", () => {
  assert.deepEqual(FAILURE_LIFECYCLE_ACTIVE_PATHS, [
    "src/pg-sql.ts",
    "src/lane-health-store.ts",
    "src/strict-gzip-reader.ts",
    "workers/data-api.ts",
  ]);
  assert.deepEqual(FAILURE_LIFECYCLE_UNFIXED_PATHS, [
    "src/pg-sql.ts",
    "src/lane-health-store.ts",
  ]);
  assert.deepEqual(FAILURE_LIFECYCLE_PURE_ONLY_PATHS, ["src/read-store.ts"]);
  assert.ok(
    !FAILURE_LIFECYCLE_ACTIVE_PATHS.includes("src/read-store.ts" as any),
  );
  for (const paths of [
    FAILURE_LIFECYCLE_ACTIVE_PATHS,
    FAILURE_LIFECYCLE_UNFIXED_PATHS,
    FAILURE_LIFECYCLE_PURE_ONLY_PATHS,
  ])
    assert.equal(Object.isFrozen(paths), true);
});
