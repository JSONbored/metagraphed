import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  DISCARDED_INPUT_SOURCE_PINS,
  DISCARDED_INPUT_RECORD_PINS,
  ERASURE_CONFIG_SOURCE_PINS,
} from "./discarded-input-proof.ts";
import { readDiscardedInputEvidence } from "./owner-build-evidence.ts";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixtureSources(
  name: string,
  pins: Record<string, { bytes: number; sha256: string; gitBlob: string }>,
): Record<string, string> {
  const envelope = JSON.parse(
    readFileSync(new URL(name, import.meta.url), "utf8"),
  );
  assert.equal(envelope.version, 1);
  assert.equal(envelope.encoding, "gzip-base64");
  const decoded = gunzipSync(Buffer.from(envelope.contents, "base64"), {
    maxOutputLength: 2 * 1024 * 1024,
  });
  assert.equal(decoded.length, envelope.decodedBytes);
  assert.equal(sha256(decoded), envelope.decodedSha256);
  const sources = JSON.parse(decoded.toString("utf8")) as Record<
    string,
    string
  >;
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(pins).sort());
  for (const [name, pin] of Object.entries(pins)) {
    const bytes = Buffer.from(sources[name]!);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(sha256(bytes), pin.sha256);
    assert.equal(
      createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
      pin.gitBlob,
    );
  }
  return sources;
}
const sources = fixtureSources(
  "./discarded-input-source-fixtures.json",
  DISCARDED_INPUT_SOURCE_PINS,
);
const configs = fixtureSources(
  "./erasure-config-source-fixtures.json",
  ERASURE_CONFIG_SOURCE_PINS,
);
function metadata(): {
  inputs: Record<
    string,
    {
      bytes: number;
      imports: { path: string; kind: string; external: boolean }[];
    }
  >;
  outputs: Record<
    string,
    { imports: { path: string; kind: string; external?: boolean }[] }
  >;
} {
  const inputs = Object.fromEntries(
    Object.entries(DISCARDED_INPUT_SOURCE_PINS).map(([name, pin]) => [
      name,
      {
        bytes: pin.bytes,
        imports: [] as { path: string; kind: string; external: boolean }[],
      },
    ]),
  );
  for (const pin of DISCARDED_INPUT_RECORD_PINS) {
    const row = inputs[pin.sourcePath]!;
    while (row.imports.length <= pin.importIndex)
      row.imports.push({
        path: "node:assert",
        kind: "import-statement",
        external: true,
      });
    row.imports[pin.importIndex] = {
      path: pin.target,
      kind: pin.kind,
      external: true,
    };
  }
  return { inputs, outputs: {} };
}
function fixture(
  action: (root: string, dependencyRoot: string, scratch: string) => void,
  populate = true,
): void {
  const scratch = realpathSync(
    mkdtempSync(path.join(tmpdir(), "owner-discarded-pure-")),
  );
  const root = path.join(scratch, "candidate"),
    dependencyRoot = path.join(scratch, "dependencies");
  try {
    mkdirSync(root);
    mkdirSync(dependencyRoot);
    symlinkSync(dependencyRoot, path.join(root, "node_modules"));
    if (populate)
      for (const [name, contents] of Object.entries({
        ...sources,
        ...configs,
      })) {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
      }
    action(root, dependencyRoot, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
test("fixed read plan preserves all 20 importer and three configuration bytes", () =>
  fixture((root, deps) => {
    const evidence = readDiscardedInputEvidence(root, deps, metadata());
    assert.deepEqual(
      Object.keys(evidence.discardedInputSources!).sort(),
      Object.keys(sources).sort(),
    );
    assert.deepEqual(
      Object.keys(evidence.erasureConfigSources!).sort(),
      Object.keys(configs).sort(),
    );
    for (const [name, bytes] of Object.entries(evidence.discardedInputSources!))
      assert.equal(
        sha256(bytes),
        DISCARDED_INPUT_SOURCE_PINS[
          name as keyof typeof DISCARDED_INPUT_SOURCE_PINS
        ].sha256,
      );
    for (const [name, bytes] of Object.entries(evidence.erasureConfigSources!))
      assert.equal(
        sha256(bytes),
        ERASURE_CONFIG_SOURCE_PINS[
          name as keyof typeof ERASURE_CONFIG_SOURCE_PINS
        ].sha256,
      );
  }));
for (const mode of [
  "empty",
  "partial",
  "foreign",
  "emitted",
  "aliased",
] as const)
  test(`unrecognized ${mode} batch performs no source or config reads`, () =>
    fixture((root, deps) => {
      const meta = metadata(),
        first = DISCARDED_INPUT_RECORD_PINS[0]!;
      if (mode === "empty") meta.inputs = {};
      if (mode === "partial")
        meta.inputs[first.sourcePath]!.imports[first.importIndex]!.external =
          false;
      if (mode === "foreign")
        meta.inputs[first.sourcePath]!.imports[first.importIndex]!.path =
          "unknown-private-target";
      if (mode === "emitted")
        meta.outputs["synthetic.js"] = {
          imports: [{ path: first.target, kind: "import-statement" }],
        };
      if (mode === "aliased") {
        meta.inputs[`./${first.sourcePath}`] = meta.inputs[first.sourcePath]!;
        delete meta.inputs[first.sourcePath];
      }
      assert.deepEqual(readDiscardedInputEvidence(root, deps, meta), {});
    }, false));
test("proxy metadata is refused without invoking traps or reading absent sources", () =>
  fixture((root, deps) => {
    let reflected = 0;
    const meta = new Proxy(
      {},
      {
        ownKeys() {
          reflected++;
          throw Error("private");
        },
        getPrototypeOf() {
          reflected++;
          throw Error("private");
        },
        getOwnPropertyDescriptor() {
          reflected++;
          throw Error("private");
        },
        get() {
          reflected++;
          throw Error("private");
        },
      },
    );
    assert.deepEqual(readDiscardedInputEvidence(root, deps, meta), {});
    assert.equal(reflected, 0);
  }, false));
for (const name of Object.keys(sources))
  test(`missing exact public importer fails closed: ${name}`, () =>
    fixture((root, deps) => {
      rmSync(path.join(root, name));
      assert.throws(() => readDiscardedInputEvidence(root, deps, metadata()));
    }));
for (const name of Object.keys(configs))
  for (const mode of ["missing", "oversized", "symlink", "directory"] as const)
    test(`configuration ${mode} fails closed: ${name}`, () =>
      fixture((root, deps, scratch) => {
        const file = path.join(root, name);
        rmSync(file);
        if (mode === "oversized") writeFileSync(file, configs[name]! + "\n");
        if (mode === "symlink") {
          const outside = path.join(scratch, "outside");
          writeFileSync(outside, configs[name]!);
          symlinkSync(outside, file);
        }
        if (mode === "directory") mkdirSync(file);
        assert.throws(() => readDiscardedInputEvidence(root, deps, metadata()));
      }));
for (const mode of [
  "oversized",
  "leaf-symlink",
  "parent-symlink",
  "directory",
] as const)
  test(`importer ${mode} fails before returning evidence`, () =>
    fixture((root, deps, scratch) => {
      const name = Object.keys(sources)[0]!,
        file = path.join(root, name);
      if (mode === "parent-symlink") {
        const parent = path.dirname(file),
          outside = path.join(scratch, "outside");
        mkdirSync(outside);
        writeFileSync(path.join(outside, path.basename(file)), sources[name]!);
        rmSync(parent, { recursive: true });
        symlinkSync(outside, parent);
      } else {
        rmSync(file);
        if (mode === "oversized") writeFileSync(file, sources[name]! + "\n");
        if (mode === "leaf-symlink") {
          const outside = path.join(scratch, "outside");
          writeFileSync(outside, sources[name]!);
          symlinkSync(outside, file);
        }
        if (mode === "directory") mkdirSync(file);
      }
      assert.throws(() => readDiscardedInputEvidence(root, deps, metadata()));
    }));
test("candidate root alias is refused", () =>
  fixture((root, deps, scratch) => {
    const alias = path.join(scratch, "alias");
    symlinkSync(root, alias);
    assert.throws(() => readDiscardedInputEvidence(alias, deps, metadata()));
  }));
test("dependency root mismatch is refused", () =>
  fixture((root, _deps, scratch) => {
    const other = path.join(scratch, "other");
    mkdirSync(other);
    assert.throws(() => readDiscardedInputEvidence(root, other, metadata()));
  }));
test("read adapter does not pretend that source reads alone grant admission", () =>
  fixture((root, deps) => {
    const name = Object.keys(sources)[0]!,
      file = path.join(root, name),
      changed = Buffer.from(sources[name]!);
    changed[0] ^= 1;
    writeFileSync(file, changed);
    const evidence = readDiscardedInputEvidence(root, deps, metadata());
    assert.notEqual(
      sha256(evidence.discardedInputSources![name]!),
      DISCARDED_INPUT_SOURCE_PINS[
        name as keyof typeof DISCARDED_INPUT_SOURCE_PINS
      ].sha256,
    );
    assert.deepEqual(Object.keys(evidence).sort(), [
      "discardedInputSources",
      "erasureConfigSources",
    ]);
  }));

import { publicBuildProofFailure } from "./owner-diagnostics.ts";
import { ownerProofReasonMarker } from "./owner-proof-reasons.ts";
for (const [mode, expected] of [
  ["missing", "evidence-007"],
  ["oversized", "evidence-024"],
  ["root-alias", "evidence-009"],
  ["dependency-mismatch", "evidence-010"],
] as const)
  test(`actual source adapter preserves the exact fixed ${mode} reason`, () =>
    fixture((root, deps, scratch) => {
      const name = Object.keys(sources)[0]!;
      let selectedRoot = root,
        selectedDeps = deps;
      if (mode === "missing") rmSync(path.join(root, name));
      if (mode === "oversized")
        writeFileSync(path.join(root, name), sources[name]! + "\n");
      if (mode === "root-alias") {
        selectedRoot = path.join(scratch, "alias");
        symlinkSync(root, selectedRoot);
      }
      if (mode === "dependency-mismatch") {
        selectedDeps = path.join(scratch, "other");
        mkdirSync(selectedDeps);
      }
      let caught: unknown;
      try {
        readDiscardedInputEvidence(selectedRoot, selectedDeps, metadata());
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error);
      assert.equal(
        ownerProofReasonMarker(caught),
        `[owner-proof-reason:${expected}]`,
      );
      const result = publicBuildProofFailure(caught);
      assert.equal(result?.reason, expected);
      assert.equal(result?.scope, "optional-adapter");
      assert.ok(!JSON.stringify(result).includes(scratch));
      assert.ok(!JSON.stringify(result).includes(name));
    }));
