import assert from "node:assert/strict";
import { test } from "node:test";
import { publicOwnerProgress, OWNER_FRAME_PATHS } from "./owner-diagnostics.ts";
import { OWNER_TESTS, OWNER_TITLES } from "./owner-test-evidence.ts";
const root = "/synthetic-candidate",
  secret = "private-URL-token-data";
function fixture() {
  return {
    testResults: OWNER_TESTS.map((name, i) => ({
      name: root + "/" + name,
      status: "failed",
      message: secret,
      assertionResults: [
        {
          title: String(OWNER_TITLES[i]),
          status: "failed",
          failureMessages: [
            `${secret}\n at arbitraryName (${root}/${OWNER_FRAME_PATHS[2]}:123:4)\n at other (${root}/${name}:83:9)`,
          ],
        },
      ],
    })),
  };
}
test("reports two fixed owner identities and numeric frames without copying raw values", () => {
  const result = publicOwnerProgress(fixture(), root);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0]!.frames, [
    { fileIndex: 0, line: 83, column: 9 },
    { fileIndex: 2, line: 123, column: 4 },
  ]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("arbitraryName"));
  assert.ok(!JSON.stringify(result).includes(root));
});
test("passed owner requires its exact single named assertion", () => {
  const v = fixture();
  for (const s of v.testResults) {
    s.status = "passed";
    s.assertionResults[0]!.status = "passed";
  }
  assert.ok(
    publicOwnerProgress(v, root).every(
      (r) => r.status === "passed" && r.frames.length === 0,
    ),
  );
});
test("missing owner remains missing", () => {
  const v = fixture();
  v.testResults.pop();
  assert.equal(publicOwnerProgress(v, root)[1]!.status, "missing");
});
test("missing required title cannot label an owner passed", () => {
  const v = fixture();
  v.testResults[0]!.status = "passed";
  v.testResults[0]!.assertionResults[0]!.status = "passed";
  v.testResults[0]!.assertionResults[0]!.title = "foreign";
  assert.equal(publicOwnerProgress(v, root)[0]!.status, "incomplete");
});
test("duplicate required case remains ambiguous", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults.push(
    v.testResults[0]!.assertionResults[0]!,
  );
  assert.equal(publicOwnerProgress(v, root)[0]!.requiredCase, "ambiguous");
});
test("failed import with no assertions emits only fixed suite-message positions", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults = [];
  v.testResults[0]!.message = `${secret}\n at file://${root}/${OWNER_FRAME_PATHS[3]}:10:2`;
  const row = publicOwnerProgress(v, root)[0]!;
  assert.equal(row.status, "failed");
  assert.equal(row.requiredCase, "missing");
  assert.deepEqual(row.frames, [{ fileIndex: 3, line: 10, column: 2 }]);
});
for (const [name, edit] of Object.entries({
  duplicate: (v: any): unknown => v.testResults.push(v.testResults[0]),
  foreign: (v: any): unknown => (v.testResults[0].name = "/outside/secret"),
  status: (v: any): unknown => (v.testResults[0].status = "secret"),
  count: (v: any): unknown =>
    (v.testResults[0].assertionResults = Array(101).fill(
      v.testResults[0].assertionResults[0],
    )),
  assertionStatus: (v: any): unknown =>
    (v.testResults[0].assertionResults[0].status = "secret"),
  suites: (v: any): unknown =>
    (v.testResults = Array(13).fill(v.testResults[0])),
}))
  test(`refuses malformed ${name}`, () => {
    const v = fixture();
    edit(v);
    assert.throws(() => publicOwnerProgress(v, root));
  });
for (const text of [
  `at https://host${root}/${OWNER_FRAME_PATHS[2]}:12:3`,
  `at ${root}/${OWNER_FRAME_PATHS[2]}:0:2`,
  `at ${root}/${OWNER_FRAME_PATHS[2]}:100000:2`,
  `at ${root}/${OWNER_FRAME_PATHS[2]}:1:10000`,
  `at ${root}/${OWNER_FRAME_PATHS[2]}:1:2-secret`,
  "x".repeat(65537),
])
  test("omits unsupported or over-budget raw frame form", () => {
    const v = fixture();
    v.testResults[0]!.assertionResults[0]!.failureMessages = [text];
    assert.deepEqual(publicOwnerProgress(v, root)[0]!.frames, []);
  });
test("numeric frames are unique and capped at five", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults[0]!.failureMessages = [
    Array.from(
      { length: 30 },
      (_, i) =>
        `at ${root}/${OWNER_FRAME_PATHS[2]}:${i + 1}:1\nat ${root}/${OWNER_FRAME_PATHS[2]}:${i + 1}:1`,
    ).join("\n"),
  ];
  const rows = publicOwnerProgress(v, root)[0]!.frames;
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((r) => r.line)).size, 5);
});
test("over-budget message array emits no frames", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults[0]!.failureMessages = Array(20).fill(
    `at ${root}/${OWNER_FRAME_PATHS[2]}:1:1`,
  );
  assert.deepEqual(publicOwnerProgress(v, root)[0]!.frames, []);
});
