import assert from "node:assert/strict";
import path from "node:path";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
export const OWNER_TESTS = [
  "tests/qualification/strict-gzip/raw-owner-resource.test.ts",
  "tests/qualification/strict-gzip/queue-owner-resource.test.ts",
] as const;
export const OWNER_TITLES = [
  "the complete API scheduled owner commits both 25-block lanes with native D1 and overlapping RPC reads",
  "the complete Data API owner overlaps two native ten-message events through real pg and drains every writer connection",
] as const;
/** Preserve the original ten-suite validator and require exactly its 490 cases.
 * The two new assertions must pass independently before the combined gate can pass. */
export function splitOwnerTests(input: Record<string, any>, root: string) {
  assert.equal(input.success, true);
  assert.equal(input.numTotalTests, 492);
  assert.equal(input.numPassedTests, 492);
  assert.equal(input.numFailedTests, 0);
  assert.equal(input.numPendingTests, 0);
  assert.equal(input.numTodoTests ?? 0, 0);
  assert.equal(input.numFailedTestSuites, 0);
  assert.ok(Array.isArray(input.testResults));
  assert.equal(input.testResults.length, 12);
  const focused: unknown[] = [],
    owners: unknown[] = [];
  const seen = new Set<string>();
  for (const suite of input.testResults) {
    assert.equal(typeof suite.name, "string");
    assert.ok(path.isAbsolute(suite.name));
    const name = path.relative(root, suite.name);
    assert.ok(!seen.has(name));
    seen.add(name);
    if ((FOCUSED_TESTS as readonly string[]).includes(name)) {
      focused.push(suite);
      continue;
    }
    const index = (OWNER_TESTS as readonly string[]).indexOf(name);
    assert.ok(index >= 0);
    assert.equal(suite.status, "passed");
    assert.equal(suite.assertionResults.length, 1);
    assert.equal(suite.assertionResults[0].title, OWNER_TITLES[index]);
    assert.equal(suite.assertionResults[0].status, "passed");
    owners.push({ path: name, passed: 1 });
  }
  assert.equal(focused.length, 10);
  assert.equal(owners.length, 2);
  const total = focused.reduce(
    (sum: number, row: any) => sum + row.assertionResults.length,
    0,
  );
  assert.equal(total, 490);
  return {
    focused: {
      ...input,
      numTotalTests: 490,
      numPassedTests: 490,
      testResults: focused,
    },
    owners,
  };
}
