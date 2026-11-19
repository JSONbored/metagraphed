import {
  OWNER_BUILD_STAGES,
  ownerBuildStageFailure,
} from "./owner-build-stages.ts";
import {
  OPTIONAL_PROOF_STAGES,
  OPTIONAL_IMPORT_CATEGORIES,
} from "./optional-pg-import.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicOwnerProgress,
  OWNER_FRAME_PATHS,
  publicBuildProofDiagnostics,
  publicBuildProofFailure,
} from "./owner-diagnostics.ts";
import { OWNER_TESTS, OWNER_TITLES } from "./owner-test-evidence.ts";
import { chainSummaryWorkspaceMarker } from "./chain-summary-workspace-probe.ts";
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

test("publishes only unique fixed refused import classifications", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults[0]!.failureMessages = [
    `${secret} [owner-import-refused:pg-native] [owner-import-refused:pg-native]`,
    "[owner-import-refused:bufferutil] [owner-import-refused:utf-8-validate] [owner-import-refused:other]",
  ];
  const result = publicOwnerProgress(v, root);
  assert.deepEqual(result[0]!.refusedBuildImports, [
    "pg-native",
    "bufferutil",
    "utf-8-validate",
    "other",
  ]);
  assert.ok(!JSON.stringify(result).includes(secret));
});
test("unknown or oversized refused import diagnostics cannot escape", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults[0]!.failureMessages = [
    `[owner-import-refused:${secret}]`,
    "x".repeat(65537) + "[owner-import-refused:pg-native]",
  ];
  assert.deepEqual(publicOwnerProgress(v, root)[0]!.refusedBuildImports, []);
});
test("passed owner never publishes stale refused import labels", () => {
  const v = fixture(),
    s = v.testResults[0]!;
  s.status = "passed";
  s.assertionResults[0]!.status = "passed";
  s.assertionResults[0]!.failureMessages = ["[owner-import-refused:pg-native]"];
  assert.deepEqual(publicOwnerProgress(v, root)[0]!.refusedBuildImports, []);
});

test("optional import checker emits only its fixed index and numeric position", () => {
  const v = fixture();
  const fileIndex = OWNER_FRAME_PATHS.indexOf(
    "tests/qualification/strict-gzip/optional-pg-import.ts",
  );
  assert.equal(fileIndex, 11);
  v.testResults[0]!.assertionResults[0]!.failureMessages = [
    `${secret} at ${root}/${OWNER_FRAME_PATHS[fileIndex]}:301:7`,
  ];
  const result = publicOwnerProgress(v, root);
  assert.deepEqual(result[0]!.frames, [{ fileIndex, line: 301, column: 7 }]);
  assert.ok(!JSON.stringify(result).includes(secret));
});

function proofMarkers(stage = "external-imports") {
  return `[owner-optional-proof-failed:${stage}]\n[owner-optional-import-counts:input:1:1:2:3:4:5:6]\n[owner-optional-import-counts:output:1:1:0:0:2:1:0]`;
}

for (const stage of OPTIONAL_PROOF_STAGES)
  test(`fixed optional proof stage ${stage} is independently distinguishable`, () => {
    const result = publicBuildProofDiagnostics([proofMarkers(stage)]);
    assert.equal(result?.scope, "optional-pg");
    assert.equal(result?.stage, stage);
    assert.deepEqual(result?.imports, [
      {
        scope: "input",
        complete: true,
        counts: Object.fromEntries(
          OPTIONAL_IMPORT_CATEGORIES.map((name, index) => [name, index + 1]),
        ),
      },
      {
        scope: "output",
        complete: true,
        counts: Object.fromEntries(
          OPTIONAL_IMPORT_CATEGORIES.map((name, index) => [
            name,
            [1, 0, 0, 2, 1, 0][index],
          ]),
        ),
      },
    ]);
  });
for (const [scope, stages] of Object.entries(OWNER_BUILD_STAGES))
  for (const stage of stages)
    test(`fixed surrounding proof stage ${scope}/${stage} is distinguishable`, () =>
      assert.deepEqual(
        publicBuildProofDiagnostics([
          `[owner-build-proof-failed:${scope}:${stage}]`,
        ]),
        { scope, stage, imports: [] },
      ));
test("incomplete scans remain explicit and cannot contain partial counts", () => {
  const marker = proofMarkers().replace(
    "input:1:1:2:3:4:5:6",
    "input:0:0:0:0:0:0:0",
  );
  const result = publicBuildProofDiagnostics([marker]);
  assert.equal(result?.imports[0]?.complete, false);
  assert.ok(
    Object.values(result!.imports[0]!.counts).every((count) => count === 0),
  );
});
const invalidProofMarkers = {
  "missing stage": proofMarkers().replace(
    "[owner-optional-proof-failed:external-imports]",
    "",
  ),
  "duplicate stage":
    proofMarkers() + "[owner-optional-proof-failed:external-imports]",
  "conflicting stage": proofMarkers() + "[owner-optional-proof-failed:roots]",
  "missing input": proofMarkers().replace(
    /\[owner-optional-import-counts:input:[^\]]+\]/,
    "",
  ),
  "duplicate input":
    proofMarkers() + "[owner-optional-import-counts:input:1:1:2:3:4:5:6]",
  "duplicate output replacing input": proofMarkers().replace(
    "counts:input:",
    "counts:output:",
  ),
  "conflicting scope":
    proofMarkers() + "[owner-build-proof-failed:raw-build:builder]",
  "unknown stage": proofMarkers(secret),
  "unknown scope": proofMarkers().replace("counts:input:", "counts:private:"),
  "unknown general stage": "[owner-build-proof-failed:raw-build:private-token]",
  "unknown general scope": "[owner-build-proof-failed:private:builder]",
  "noncanonical integer": proofMarkers().replace("input:1:1:", "input:1:01:"),
  "negative integer": proofMarkers().replace("input:1:1:", "input:1:-1:"),
  "fractional integer": proofMarkers().replace("input:1:1:", "input:1:1.5:"),
  "individual overflow": proofMarkers().replace("input:1:1:", "input:1:65537:"),
  "total overflow": proofMarkers().replace("input:1:1:2:", "input:1:65536:1:"),
  "partial counts": proofMarkers().replace("input:1:", "input:0:"),
  "bad completeness": proofMarkers().replace("input:1:", "input:2:"),
  "truncated marker": proofMarkers().slice(0, -1),
  "multiline marker": proofMarkers().replace("input:1:", "input:\n1:"),
  "oversized message": "x".repeat(65537) + proofMarkers(),
};
for (const [name, marker] of Object.entries(invalidProofMarkers))
  test(`omits malformed proof diagnostics: ${name}`, () =>
    assert.equal(publicBuildProofDiagnostics([marker]), null));
test("non-string and oversized arrays cannot supply proof diagnostics", () => {
  assert.equal(publicBuildProofDiagnostics([{}]), null);
  assert.equal(
    publicBuildProofDiagnostics(Array(20).fill(proofMarkers())),
    null,
  );
});
test("private text surrounding valid markers is never published", () => {
  const result = publicBuildProofDiagnostics([`${secret} ${proofMarkers()}`]);
  assert.ok(result);
  assert.ok(!JSON.stringify(result).includes(secret));
});
test("only one failed required assertion can supply proof diagnostics", () => {
  const v = fixture();
  v.testResults[0]!.assertionResults[0]!.failureMessages = [proofMarkers()];
  assert.equal(
    publicOwnerProgress(v, root)[0]!.buildProof?.scope,
    "optional-pg",
  );
  v.testResults[0]!.assertionResults[0]!.status = "passed";
  assert.equal(publicOwnerProgress(v, root)[0]!.buildProof, null);
  v.testResults[0]!.assertionResults[0]!.status = "failed";
  v.testResults[0]!.assertionResults.push(
    v.testResults[0]!.assertionResults[0]!,
  );
  assert.equal(publicOwnerProgress(v, root)[0]!.buildProof, null);
});
test("suite message alone cannot supply proof diagnostics", () => {
  const v = fixture();
  v.testResults[0]!.message = proofMarkers();
  assert.equal(publicOwnerProgress(v, root)[0]!.buildProof, null);
});

test("publisher failure diagnostics use only private brands and never read arbitrary errors", () => {
  const arbitrary = new Proxy(
    {},
    {
      get() {
        throw new Error("private getter");
      },
      getOwnPropertyDescriptor() {
        throw new Error("private descriptor");
      },
    },
  );
  assert.equal(publicBuildProofFailure(arbitrary), null);
  assert.equal(
    publicBuildProofFailure(
      new Error("[owner-build-proof-failed:raw-build:builder]"),
    ),
    null,
  );
  const branded = ownerBuildStageFailure(
    "association",
    "raw-source-maps",
    arbitrary,
  );
  assert.deepEqual(publicBuildProofFailure(branded), {
    scope: "association",
    stage: "raw-source-maps",
    imports: [],
  });
  assert.ok(
    !JSON.stringify(publicBuildProofFailure(branded)).includes("private"),
  );
});

// Failure-only exact-predicate labels are independently rebuilt from fixed enums.
import { OWNER_PROOF_REASON_CODES } from "./owner-proof-reason-codes.ts";
import { ownerProofFailure } from "./owner-proof-reasons.ts";
const validInputKeyMarker =
  "[owner-optional-input-key-counts:1:8:1:2:1:1:1:1:1:1:0]";
for (const code of OWNER_PROOF_REASON_CODES)
  test(`publishes only reviewed exact predicate reason ${code}`, () => {
    const value = publicBuildProofDiagnostics([
      proofMarkers() + `\n[owner-proof-reason:${code}]\n` + validInputKeyMarker,
    ]);
    assert.equal(value?.reason, code);
    assert.deepEqual(value?.inputKeys, {
      complete: true,
      scanned: 8,
      duplicateLogicalIdentities: 1,
      counts: {
        project: 2,
        dependency: 1,
        "valid-builtin": 1,
        "invalid-builtin-namespace": 1,
        "disabled-namespace": 1,
        "other-namespace": 1,
        "invalid-path": 1,
        "escaped-root": 0,
      },
    });
  });
for (const marker of [
  "[owner-proof-reason:private-token]",
  "[owner-proof-reason]",
  "[owner-optional-input-key-counts]",
  "[owner-proof-reason:opg-001] [owner-proof-reason:opg-001]",
  "[owner-proof-reason:opg-001] [owner-proof-reason:evidence-001]",
  "[owner-proof-reason:opg-001",
  "[owner-proof-reason:opg-001\n]",
  validInputKeyMarker + validInputKeyMarker,
  validInputKeyMarker.replace(":1:8:", ":1:9:"),
  validInputKeyMarker.replace(":1:8:", ":1:08:"),
  validInputKeyMarker.replace(":1:8:", ":1:8193:"),
  validInputKeyMarker.replace(":1:8:", ":0:8:"),
  validInputKeyMarker.replace(":8:1:", ":8:4:"),
  "[owner-optional-input-key-counts:private-token]",
])
  test("malformed, duplicated or inconsistent predicate diagnostics are omitted", () => {
    assert.equal(
      publicBuildProofDiagnostics([proofMarkers() + "\n" + marker]),
      null,
    );
  });
test("fixed census and reason can appear in separate bounded failure messages", () => {
  const result = publicBuildProofDiagnostics([
    proofMarkers(),
    validInputKeyMarker,
    "[owner-proof-reason:opg-001]",
  ]);
  assert.equal(result?.reason, "opg-001");
  assert.equal(result?.inputKeys?.scanned, 8);
});
test("a duplicate reason split across messages cannot be merged", () => {
  assert.equal(
    publicBuildProofDiagnostics([
      proofMarkers(),
      "[owner-proof-reason:opg-001]",
      "[owner-proof-reason:opg-001]",
    ]),
    null,
  );
});
test("a duplicate census split across messages cannot be merged", () => {
  assert.equal(
    publicBuildProofDiagnostics([
      proofMarkers(),
      validInputKeyMarker,
      validInputKeyMarker,
    ]),
    null,
  );
});
test("incomplete input-key census publishes explicit zero observations", () => {
  const result = publicBuildProofDiagnostics([
    proofMarkers() +
      "\n[owner-optional-input-key-counts:0:0:0:0:0:0:0:0:0:0:0]",
  ]);
  assert.equal(result?.inputKeys?.complete, false);
  assert.equal(result?.inputKeys?.scanned, 0);
});
test("input-key census cannot attach to an unrelated surrounding stage", () => {
  assert.equal(
    publicBuildProofDiagnostics([
      "[owner-build-proof-failed:raw-build:builder]\n" + validInputKeyMarker,
    ]),
    null,
  );
});
test("surrounding build failure retains its deepest fixed predicate reason", () => {
  const cause = ownerProofFailure(new Error(secret), "evidence-001");
  const wrapped = ownerBuildStageFailure("association", "raw-inputs", cause);
  assert.equal(publicBuildProofFailure(wrapped)?.reason, "evidence-001");
  assert.ok(!JSON.stringify(publicBuildProofFailure(wrapped)).includes(secret));
});
test("public proof reduction does not inspect Proxy or accessor messages", () => {
  let touched = 0;
  const proxy = new Proxy([], {
    get() {
      touched++;
      throw Error(secret);
    },
    getOwnPropertyDescriptor() {
      touched++;
      throw Error(secret);
    },
  });
  assert.equal(publicBuildProofDiagnostics(proxy), null);
  const messages = [] as unknown[];
  Object.defineProperty(messages, "0", {
    get() {
      touched++;
      throw Error(secret);
    },
  });
  assert.equal(publicBuildProofDiagnostics(messages), null);
  assert.equal(touched, 0);
});
test("passed owner assertions cannot publish stale reason or census diagnostics", () => {
  const value = fixture(),
    suite = value.testResults[0]!;
  suite.status = "passed";
  suite.assertionResults[0]!.status = "passed";
  suite.assertionResults[0]!.failureMessages = [
    proofMarkers() + "\n[owner-proof-reason:opg-001]\n" + validInputKeyMarker,
  ];
  assert.equal(publicOwnerProgress(value, root)[0]!.buildProof, null);
});
const workspaceInputReport = {
  version: 1,
  identity: "chain-summaries-dist",
  status: "identified",
  inputScanComplete: true,
  inputCount: 1483,
  escapedCount: 1,
  exactMatches: 1,
  otherEscapedCount: 0,
  matchedEdges: 2,
} as const;
const workspaceCensus =
  "[owner-optional-input-key-counts:1:1483:0:878:593:11:0:0:0:0:1]";
function workspaceProofMessages() {
  return [
    proofMarkers(),
    workspaceCensus,
    chainSummaryWorkspaceMarker(workspaceInputReport),
  ];
}
test("failed proof can publish a fixed workspace identity observation with matching census", () => {
  const result = publicBuildProofDiagnostics(workspaceProofMessages());
  assert.deepEqual(result?.workspaceInput, workspaceInputReport);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes(secret));
});
for (const [label, mutate] of Object.entries({
  missingCensus: (messages: string[]) => messages.filter((_, i) => i !== 1),
  incompleteCensus: (messages: string[]) => [
    messages[0]!,
    "[owner-optional-input-key-counts:0:0:0:0:0:0:0:0:0:0:0]",
    messages[2]!,
  ],
  wrongInputTotal: (messages: string[]) =>
    messages.map((value, i) =>
      i === 1 ? value.replace(":1483:0:878:", ":1482:0:877:") : value,
    ),
  wrongEscapedCount: (messages: string[]) =>
    messages.map((value, i) =>
      i === 1
        ? value.replace(":878:593:11:0:0:0:0:1]", ":879:593:11:0:0:0:0:0]")
        : value,
    ),
  duplicateMarker: (messages: string[]) => [...messages, messages[2]!],
  repeatedWithinMessage: (messages: string[]) =>
    messages.map((value, i) => (i === 2 ? value + value : value)),
  malformedMarker: (messages: string[]) => [
    ...messages,
    "[owner-workspace-input]",
  ],
  unknownMarker: (messages: string[]) => [
    messages[0]!,
    messages[1]!,
    "[owner-workspace-input:private-secret]",
  ],
}))
  test(`workspace observation refuses ${label} without weakening proof failure`, () => {
    assert.equal(
      publicBuildProofDiagnostics(mutate(workspaceProofMessages())),
      null,
    );
  });
test("workspace observation cannot attach to an unrelated surrounding build stage", () => {
  assert.equal(
    publicBuildProofDiagnostics([
      "[owner-build-proof-failed:raw-build:builder]",
      chainSummaryWorkspaceMarker(workspaceInputReport),
    ]),
    null,
  );
});
for (const [label, census] of Object.entries({
  duplicateIdentity:
    "[owner-optional-input-key-counts:1:1483:1:878:593:11:0:0:0:0:1]",
  invalidBuiltinNamespace:
    "[owner-optional-input-key-counts:1:1483:0:877:593:11:1:0:0:0:1]",
  disabledNamespace:
    "[owner-optional-input-key-counts:1:1483:0:877:593:11:0:1:0:0:1]",
  otherNamespace:
    "[owner-optional-input-key-counts:1:1483:0:877:593:11:0:0:1:0:1]",
  invalidPath:
    "[owner-optional-input-key-counts:1:1483:0:877:593:11:0:0:0:1:1]",
}))
  test(`complete workspace observation rejects contradictory ${label} census`, () => {
    const messages = workspaceProofMessages();
    messages[1] = census;
    assert.equal(publicBuildProofDiagnostics(messages), null);
  });
test("passed owner assertions cannot publish stale workspace observations", () => {
  const value = fixture(),
    suite = value.testResults[0]!;
  suite.status = "passed";
  suite.assertionResults[0]!.status = "passed";
  suite.assertionResults[0]!.failureMessages = workspaceProofMessages();
  assert.equal(publicOwnerProgress(value, root)[0]!.buildProof, null);
});
