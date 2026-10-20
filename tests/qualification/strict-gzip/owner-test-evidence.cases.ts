import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
import {
  OWNER_TESTS,
  OWNER_TITLES,
  splitOwnerTests,
} from "./owner-test-evidence.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";
const root = "/synthetic-candidate";
function fixture() {
  const testResults = FOCUSED_TESTS.map((file, index) => ({
    name: path.join(root, file),
    status: "passed",
    assertionResults: Array.from({ length: index === 0 ? 481 : 1 }, () => ({
      title: "synthetic",
      status: "passed",
    })),
  }));
  testResults.push(
    ...OWNER_TESTS.map((file, index) => ({
      name: path.join(root, file),
      status: "passed",
      assertionResults: [{ title: OWNER_TITLES[index]!, status: "passed" }],
    })),
  );
  return {
    success: true,
    numTotalTests: 492,
    numPassedTests: 492,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults,
  };
}
test("requires 490 unchanged focused assertions plus two exact owner assertions", () => {
  const result = splitOwnerTests(fixture(), root);
  assert.equal(result.focused.numTotalTests, 490);
  assert.equal(result.focused.testResults.length, 10);
  assert.equal(result.owners.length, 2);
});
for (const [name, edit] of Object.entries({
  "missing original suite": (v: ReturnType<typeof fixture>) =>
    v.testResults.shift(),
  "missing owner": (v: ReturnType<typeof fixture>) => v.testResults.pop(),
  "duplicate owner": (v: ReturnType<typeof fixture>) =>
    (v.testResults[11] = v.testResults[10]!),
  "wrong native title": (v: ReturnType<typeof fixture>) =>
    (v.testResults[11]!.assertionResults[0]!.title = "other"),
  "skipped owner": (v: ReturnType<typeof fixture>) =>
    (v.testResults[11]!.assertionResults[0]!.status = "pending"),
  "failed owner": (v: ReturnType<typeof fixture>) =>
    (v.testResults[10]!.status = "failed"),
  "extra assertion": (v: ReturnType<typeof fixture>) =>
    v.testResults[10]!.assertionResults.push({
      title: "extra",
      status: "passed",
    }),
  "replaced original assertion": (v: ReturnType<typeof fixture>) =>
    v.testResults[0]!.assertionResults.pop(),
  "invented count": (v: ReturnType<typeof fixture>) => (v.numTotalTests = 493),
}))
  test(`rejects ${name}`, () => {
    const value = fixture();
    edit(value);
    assert.throws(() => splitOwnerTests(value, root));
  });
test("deadline returns actual fulfillment", async () =>
  assert.equal(await withinOwnerDeadline(Promise.resolve(1), 100), 1));
test("deadline preserves actual rejection", async () =>
  assert.rejects(
    () => withinOwnerDeadline(Promise.reject(new Error("synthetic")), 100),
    /synthetic/,
  ));
test("deadline bounds an unsettled event without pretending cancellation", async () =>
  assert.rejects(
    () => withinOwnerDeadline(new Promise(() => {}), 5),
    /deadline/,
  ));
