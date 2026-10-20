import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  OWNER_PUBLIC_SOURCE_INDEX_SHA256,
  publicInputDiagnosticMarkers,
  publicInputIdentityDiagnostics,
  publicInputSourcePins,
  readPublicInputSources,
  withPublicInputDiagnostics,
} from "./owner-input-diagnostics.ts";
import { optionalPgBuildAssociation } from "./owner-build-evidence.ts";
import { ownerBuildStageFailure } from "./owner-build-stages.ts";
import {
  publicBuildProofFailure,
  publicInputIdentityFailure,
  publicOwnerProgress,
} from "./owner-diagnostics.ts";
import { OWNER_TESTS, OWNER_TITLES } from "./owner-test-evidence.ts";

// Exact public fixture: packages/ui-kit/src/lib/utils.ts at the pinned base.
const sourcePath = "packages/ui-kit/src/lib/utils.ts";
const source = `import clsx from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(...inputs));
}
`;
const prefix = "[owner-public-input-identities:";
const suffix = ":end-owner-public-input-identities]";
const marker = (value: unknown) => prefix + JSON.stringify(value) + suffix;
function fixture(
  action: (value: {
    root: string;
    dependencyRoot: string;
    metafile: any;
    failure: () => Error;
  }) => void,
) {
  const scratch = mkdtempSync(path.join(tmpdir(), "public-input-diagnostic-"));
  const root = path.join(scratch, "candidate");
  const dependencyRoot = path.join(root, "node_modules");
  mkdirSync(path.join(root, path.dirname(sourcePath)), { recursive: true });
  mkdirSync(dependencyRoot);
  writeFileSync(path.join(root, sourcePath), source);
  const metafile = {
    inputs: {
      [sourcePath]: {
        bytes: Buffer.byteLength(source),
        imports: [
          { path: "clsx", kind: "import-statement", external: true },
          { path: "tailwind-merge", kind: "import-statement", external: true },
        ],
      },
    },
    outputs: {
      "out/api.entry.js": { bytes: 1, inputs: {}, imports: [] },
    },
  };
  const failure = () => {
    let thrown: unknown;
    try {
      optionalPgBuildAssociation(
        root,
        path.join(root, "out"),
        metafile,
        [],
        ["api.entry.js"],
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, "Existing input import must still fail");
    return thrown;
  };
  try {
    action({ root, dependencyRoot, metafile, failure });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
test("the public index matches its immutable hash and remains frozen", () => {
  const bytes = readFileSync(
    new URL("./owner-public-source-index.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    OWNER_PUBLIC_SOURCE_INDEX_SHA256,
  );
  const pins = publicInputSourcePins();
  assert.equal(pins.length, 3231);
  assert.ok(Object.isFrozen(pins) && pins.every(Object.isFrozen));
  const fixturePin = pins.find((row) => row.path === sourcePath)!;
  assert.equal(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
    fixturePin.gitBlob,
  );
});
test("the original proof still refuses and publishes only exact public identities", () =>
  fixture(({ failure }) => {
    const error = failure();
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(
      error.message.match(/\[owner-optional-proof-failed:/g)?.length,
      1,
    );
    assert.equal(publicBuildProofFailure(error)?.stage, "external-imports");
    const report = publicInputIdentityFailure(error)!;
    assert.equal(report.complete, true);
    assert.equal(report.identifiedCount, 2);
    assert.deepEqual(
      report.records.map((row) => row.sourcePath),
      [sourcePath, sourcePath],
    );
    assert.deepEqual(
      report.records.map((row) => row.importIndex),
      [0, 1],
    );
    assert.deepEqual(
      report.records.map((row) => row.literalLocations),
      [[{ line: 1, column: 18 }], [{ line: 2, column: 25 }]],
    );
    assert.ok(!JSON.stringify(report).includes("tailwind-merge"));
    assert.ok(!JSON.stringify(report).includes("clsx"));
    assert.equal(
      ownerBuildStageFailure("raw-build", "optional-proof", error),
      error,
    );
    assert.equal(
      publicInputIdentityDiagnostics([error.message])?.identifiedCount,
      2,
    );
  }));
test("unbranded causes cannot trigger filesystem access or marker publication", () => {
  let traps = 0;
  const cause = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("private");
      },
    },
  );
  assert.equal(
    withPublicInputDiagnostics(cause, "/no-such-root", cause),
    cause,
  );
  assert.equal(publicInputDiagnosticMarkers(cause), "");
  assert.equal(publicInputIdentityFailure(cause), null);
  assert.equal(traps, 0);
});
test("public progress needs the exact failed required assertion and optional proof markers", () =>
  fixture(({ root, failure }) => {
    const error = failure();
    const suite = {
      name: path.join(root, OWNER_TESTS[0]),
      status: "failed",
      assertionResults: [
        {
          title: OWNER_TITLES[0],
          status: "failed",
          failureMessages: [error.message],
        },
      ],
    };
    assert.equal(
      publicOwnerProgress({ testResults: [suite] }, root)[0]!
        .inputOnlyPublicIdentities?.identifiedCount,
      2,
    );
    suite.status = "passed";
    suite.assertionResults[0]!.status = "passed";
    assert.equal(
      publicOwnerProgress({ testResults: [suite] }, root)[0]!
        .inputOnlyPublicIdentities,
      null,
    );
    suite.status = "failed";
    suite.assertionResults[0]!.status = "failed";
    suite.assertionResults[0]!.failureMessages = [
      marker(publicInputIdentityFailure(error)),
    ];
    assert.equal(
      publicOwnerProgress({ testResults: [suite] }, root)[0]!
        .inputOnlyPublicIdentities,
      null,
    );
  }));
for (const [label, edit] of Object.entries({
  missing: (root: string) => rmSync(path.join(root, sourcePath)),
  changed: (root: string) =>
    writeFileSync(path.join(root, sourcePath), source + "// changed"),
  oversized: (root: string) =>
    writeFileSync(path.join(root, sourcePath), "x".repeat(2 * 1024 * 1024 + 1)),
  directory: (root: string) => {
    rmSync(path.join(root, sourcePath));
    mkdirSync(path.join(root, sourcePath));
  },
  leafAlias: (root: string) => {
    renameSync(path.join(root, sourcePath), path.join(root, "other.ts"));
    symlinkSync(path.join(root, "other.ts"), path.join(root, sourcePath));
  },
  parentAlias: (root: string) => {
    renameSync(path.join(root, "packages"), path.join(root, "other"));
    symlinkSync(path.join(root, "other"), path.join(root, "packages"));
  },
}))
  test(`source ${label} cannot produce a complete identity report`, () =>
    fixture(({ root, failure }) => {
      edit(root);
      const report = publicInputIdentityFailure(failure())!;
      assert.equal(report.complete, false);
      assert.equal(report.identifiedCount, 0);
      assert.equal(report.refusedCount, 2);
      assert.equal(
        report.refused.missingSource + report.refused.sourceMismatch,
        2,
      );
    }));
test("a parent symlink escaping the candidate is refused before any source read", () =>
  fixture(({ root, dependencyRoot, metafile }) => {
    const outside = path.join(path.dirname(root), "outside");
    renameSync(path.join(root, "packages"), outside);
    symlinkSync(outside, path.join(root, "packages"));
    assert.deepEqual(
      Object.keys(readPublicInputSources(root, dependencyRoot, metafile)),
      [],
    );
    assert.equal(
      readFileSync(path.join(outside, "ui-kit/src/lib/utils.ts"), "utf8"),
      source,
    );
  }));
test("unindexed metadata paths and secret-like targets never escape", () =>
  fixture(({ metafile, failure }) => {
    metafile.inputs["https://private.invalid/token"] = {
      bytes: 1,
      imports: [
        { path: "private-secret", external: true, kind: "import-statement" },
      ],
    };
    const report = publicInputIdentityFailure(failure())!;
    assert.equal(report.complete, false);
    assert.equal(report.refused.unindexed, 1);
    assert.ok(!JSON.stringify(report).includes("private"));
  }));
for (const [label, mutate] of Object.entries({
  duplicate: (message: string) => [message, message],
  truncated: (message: string) => [message.replace(suffix, "")],
  brokenJson: () => [prefix + "{" + suffix],
  oversized: () => ["x".repeat(65537)],
  rawSecret: () => [
    prefix + JSON.stringify({ secret: "private-url" }) + suffix,
  ],
  wrongPin: (message: string) => [
    message.replace(
      /"gitBlob":"[a-f0-9]{40}"/,
      `"gitBlob":"${"f".repeat(40)}"`,
    ),
  ],
  foreignPath: (message: string) => [
    message.replaceAll(sourcePath, "private/source.ts"),
  ],
  inconsistentCount: (message: string) => [
    message.replace('"identifiedCount":2', '"identifiedCount":1'),
  ],
}))
  test(`serialized ${label} report is omitted`, () =>
    fixture(({ failure }) => {
      assert.equal(
        publicInputIdentityDiagnostics(mutate(failure().message)),
        null,
      );
    }));
test("serialized message accessors and proxies are not invoked", () => {
  let traps = 0;
  const messages: unknown[] = [];
  Object.defineProperty(messages, "0", {
    get() {
      traps++;
      throw new Error("private");
    },
  });
  assert.equal(publicInputIdentityDiagnostics(messages), null);
  const proxy = new Proxy([], {
    get() {
      traps++;
      throw new Error("private");
    },
  });
  assert.equal(publicInputIdentityDiagnostics(proxy), null);
  assert.equal(traps, 0);
});
test("a matching output target prevents an input-only identity", () =>
  fixture(({ metafile, failure }) => {
    metafile.outputs["out/api.entry.js"].imports.push({
      path: "clsx",
      kind: "import-statement",
      external: false,
    });
    const report = publicInputIdentityFailure(failure())!;
    assert.equal(report.complete, false);
    assert.equal(report.refused.emittedTarget, 1);
    assert.equal(report.identifiedCount, 1);
  }));
