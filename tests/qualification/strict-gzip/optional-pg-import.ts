// Proposed test-only metadata validator. Does not load pg, build, resolve, or run code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

export const OPTIONAL_PG_SOURCE_COMMIT =
  "b617619f9fb6fbd231731823e2732a2927ded4be";
export const OPTIONAL_PG_SOURCE_PINS = Object.freeze({
  "node_modules/pg/esm/index.mjs":
    "5ef4d06556eeb775987759c2c09229dca2139421ee40e819b566612db2b4a8dc",
  "node_modules/pg/lib/index.js":
    "3fad6e6d3d976edbabe0cbc9e1d39f4340bcb719bbbb186a0d3a24f3dbd4a94c",
  "node_modules/pg/lib/native/index.js":
    "99fb61cb78a6d78b7a5fc0b9ac264ad58272af48be4bc50bfdb948b1342e3292",
  "node_modules/pg/lib/native/client.js":
    "d88c124d4835cc9d5b0389e2aaf63a144df8434c1b4b0d5e588691e068f49acf",
});
const ESM = "node_modules/pg/esm/index.mjs";
const MAIN = "node_modules/pg/lib/index.js";
const NATIVE_INDEX = "node_modules/pg/lib/native/index.js";
const CLIENT = "node_modules/pg/lib/native/client.js";
const MAX_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export interface ImportRecord {
  path: string;
  kind: string;
  external?: boolean;
  original?: string;
}
export interface OptionalPgMetafile {
  inputs: Record<string, { bytes: number; imports: ImportRecord[] }>;
  outputs: Record<
    string,
    {
      bytes: number;
      imports: ImportRecord[];
      inputs: Record<string, { bytesInOutput: number }>;
    }
  >;
}
export interface PreservedOptionalPgOutput {
  // Exact output key and exact map key from the genuine builder metafile.
  metafilePath: string;
  bytes: Uint8Array;
  sourceMap: { metafilePath: string; bytes: Uint8Array };
}
export interface OptionalPgEvidence {
  sourceRoot: string;
  dependencyRoot: string;
  outputRoot: string;
  metafile: OptionalPgMetafile;
  // Bounded, canonical reads by the caller. No supplied hashes are trusted.
  sources: Record<string, Uint8Array>;
  // All executable JS outputs, not a hand-selected pg-containing subset.
  outputs: PreservedOptionalPgOutput[];
  // Complete actual registered-module inventory, checked by the caller.
  registeredModuleNames: string[];
}
interface SourceMapV3 {
  version: number;
  sourceRoot?: string;
  sections?: unknown;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}
interface Mapping {
  line: number;
  column: number;
  source: number | null;
  originalLine: number | null;
  originalColumn: number | null;
}

function absolute(value: string) {
  assert.equal(typeof value, "string");
  assert.ok(path.isAbsolute(value) && path.normalize(value) === value);
}
function relative(value: string) {
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0 && value.length <= 1024);
  assert.ok(!path.isAbsolute(value) && !/[\\\0]/.test(value));
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
}
function within(root: string, file: string) {
  assert.ok(
    file.startsWith(root + path.sep),
    "Output escaped the reviewed root",
  );
}
function suppliedNative(value: string) {
  return /(?:^|[/:\\])pg-native(?:$|[./\\])|\.node(?:$|[?#])/.test(value);
}
function exactOptional(dependency: ImportRecord) {
  assert.equal(dependency.path, "pg-native");
  assert.equal(dependency.kind, "require-call");
  assert.equal(dependency.external, true);
  assert.ok(
    dependency.original === undefined || dependency.original === "pg-native",
  );
}

// Source-map mappings are decoded as data. Requiring a real mapping segment
// prevents an unrelated, unused sourcesContent entry from satisfying provenance.
function decodeMappings(
  map: SourceMapV3,
  output: string,
  budget: { mappings: number },
): Mapping[] {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const generatedLines = output.split("\n");
  const sourceLines = map.sourcesContent.map((content) => content?.split("\n"));
  let source = 0,
    originalLine = 0,
    originalColumn = 0,
    name = 0;
  const result: Mapping[] = [];
  const lines = map.mappings.split(";");
  assert.ok(lines.length <= generatedLines.length);
  for (let line = 0; line < lines.length; line++) {
    let column = 0;
    if (!lines[line]) continue;
    for (const segment of lines[line]!.split(",")) {
      assert.ok(segment.length > 0 && segment.length <= 100);
      const values: number[] = [];
      let value = 0,
        shift = 0;
      for (const character of segment) {
        const digit = alphabet.indexOf(character);
        assert.ok(digit >= 0 && shift <= 30, "Invalid source-map VLQ");
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        values.push(value % 2 ? -Math.floor(value / 2) : value / 2);
        value = 0;
        shift = 0;
      }
      assert.equal(shift, 0);
      assert.ok(
        values.length === 1 || values.length === 4 || values.length === 5,
      );
      assert.ok(values[0]! >= 0);
      column += values[0]!;
      assert.ok(column <= generatedLines[line]!.length);
      if (values.length === 1) {
        assert.ok(
          ++budget.mappings <= 2_000_000,
          "Whole-graph mapping budget exceeded",
        );
        result.push({
          line,
          column,
          source: null,
          originalLine: null,
          originalColumn: null,
        });
        continue;
      }
      source += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      assert.ok(source >= 0 && source < map.sources.length);
      assert.ok(originalLine >= 0 && originalColumn >= 0);
      const original = sourceLines[source];
      // Null unrelated source contents are permitted by the map format. Pinned
      // sources below are required to have exact non-null bytes.
      if (original) {
        assert.ok(originalLine < original.length);
        assert.ok(originalColumn <= original[originalLine]!.length);
      }
      if (values.length === 5) {
        name += values[4]!;
        assert.ok(name >= 0 && name < map.names.length);
      }
      assert.ok(
        ++budget.mappings <= 2_000_000,
        "Whole-graph mapping budget exceeded",
      );
      result.push({ line, column, source, originalLine, originalColumn });
    }
  }
  return result;
}

/**
 * Recognizes one unresolved optional pg-native require in a complete, genuine
 * production API build. This is not permission to supply/load native modules,
 * a proof the optional branch never ran, or a universally closed graph claim.
 * The caller must already establish the unmodified builder, build custody,
 * exact output/map bytes, and no native package/alias/force-native binding.
 * Throws for missing provenance. Does not change the builtin import policy.
 */
export function validateOptionalPgNativeImport(evidence: OptionalPgEvidence) {
  for (const root of [
    evidence.sourceRoot,
    evidence.dependencyRoot,
    evidence.outputRoot,
  ])
    absolute(root);
  const { metafile: meta } = evidence;
  assert.ok(meta && meta.inputs && meta.outputs);
  const inputNames = Object.keys(meta.inputs),
    outputNames = Object.keys(meta.outputs);
  assert.ok(inputNames.length > 0 && inputNames.length <= 8192);
  assert.ok(outputNames.length > 0 && outputNames.length <= 1024);
  for (const name of [...inputNames, ...outputNames]) {
    assert.equal(typeof name, "string");
    assert.ok(
      !suppliedNative(name),
      "Supplied pg-native or native addon is forbidden",
    );
  }
  let mentionsOptional = false;
  for (const info of Object.values(meta.outputs))
    assert.ok(Array.isArray(info.imports));
  for (const info of [
    ...Object.values(meta.inputs),
    ...Object.values(meta.outputs),
  ]) {
    // Legacy synthetic no-exception graphs omit input import arrays. They can
    // return null, but can never establish an optional-import exception.
    assert.ok(info.imports === undefined || Array.isArray(info.imports));
    for (const dependency of info.imports ?? []) {
      assert.equal(typeof dependency.path, "string");
      assert.ok(
        !suppliedNative(dependency.path) || dependency.path === "pg-native",
        "Supplied native dependency is forbidden",
      );
      if (dependency.external && dependency.path !== "pg-native") {
        assert.match(
          dependency.path,
          /^(?:node:|cloudflare:)/,
          "Unreviewed external package",
        );
      }
      if (
        dependency.path === "pg-native" ||
        dependency.original === "pg-native"
      )
        mentionsOptional = true;
    }
  }
  assert.ok(Array.isArray(evidence.registeredModuleNames));
  assert.ok(
    evidence.registeredModuleNames.length > 0 &&
      evidence.registeredModuleNames.length <= 1024,
  );
  const moduleNames = new Set(evidence.registeredModuleNames);
  assert.equal(moduleNames.size, evidence.registeredModuleNames.length);
  for (const name of moduleNames) {
    relative(name);
    assert.ok(
      !suppliedNative(name),
      "Supplied native runtime module is forbidden",
    );
  }
  // No exception is needed. The caller retains its ordinary closed-graph and
  // builtin checks; absent optional-source provenance cannot grant an exception.
  if (!mentionsOptional) return null;
  for (const info of Object.values(meta.inputs))
    assert.ok(Array.isArray(info.imports), "Missing input import provenance");
  const executableModuleNames = outputNames
    .filter((name) => !name.endsWith(".map"))
    .map((name) => {
      const absoluteOutput = path.resolve(evidence.sourceRoot, name);
      within(evidence.outputRoot, absoluteOutput);
      assert.ok(name.endsWith(".js") || name.endsWith(".wasm"));
      return path.relative(evidence.outputRoot, absoluteOutput);
    });
  assert.deepEqual([...moduleNames].sort(), executableModuleNames.sort());
  const pins = Object.entries(OPTIONAL_PG_SOURCE_PINS);
  assert.deepEqual(
    Object.keys(evidence.sources).sort(),
    pins.map(([name]) => name).sort(),
  );
  for (const [name, pin] of pins) {
    const bytes = evidence.sources[name];
    assert.ok(
      bytes instanceof Uint8Array &&
        bytes.length > 0 &&
        bytes.length <= MAX_BYTES,
    );
    assert.equal(sha256(bytes), pin, "Pinned optional pg source changed");
    assert.ok(Object.hasOwn(meta.inputs, name), "Exact pinned input absent");
    assert.equal(meta.inputs[name]!.bytes, bytes.length);
    // A second path alias to a reviewed input must not camouflage an importer.
    const target = path.resolve(evidence.sourceRoot, name);
    const dependencyTarget = path.resolve(
      evidence.dependencyRoot,
      name.slice("node_modules/".length),
    );
    assert.deepEqual(
      inputNames.filter((input) => {
        const absoluteInput = path.resolve(evidence.sourceRoot, input);
        return absoluteInput === target || absoluteInput === dependencyTarget;
      }),
      [name],
    );
  }
  const edges = [
    [ESM, MAIN, "import-statement"],
    [MAIN, NATIVE_INDEX, "require-call"],
    [NATIVE_INDEX, CLIENT, "require-call"],
  ];
  for (const [from, to, kind] of edges) {
    assert.ok(
      meta.inputs[from!]!.imports.some(
        (item) =>
          item.path === to && item.kind === kind && item.external !== true,
      ),
      "Pinned native branch association absent",
    );
  }
  const optionalInputs: { name: string; index: number }[] = [];
  for (const [name, info] of Object.entries(meta.inputs)) {
    assert.ok(Array.isArray(info.imports));
    for (const [index, dependency] of info.imports.entries()) {
      if (
        dependency.path === "pg-native" ||
        dependency.original === "pg-native"
      ) {
        exactOptional(dependency);
        assert.equal(
          name,
          CLIENT,
          "Optional require originates from an unreviewed input",
        );
        optionalInputs.push({ name, index });
      }
      assert.ok(
        !suppliedNative(dependency.path) || dependency.path === "pg-native",
        "Resolved native input forbidden",
      );
    }
  }
  assert.equal(
    optionalInputs.length,
    1,
    "Exactly one optional input require is required",
  );

  const executableNames = outputNames.filter((name) => name.endsWith(".js"));
  assert.ok(
    Array.isArray(evidence.outputs) &&
      evidence.outputs.length === executableNames.length,
  );
  assert.deepEqual(
    evidence.outputs.map((item) => item.metafilePath).sort(),
    executableNames.sort(),
  );
  const approved: {
    output: string;
    importIndex: number;
    sourceMapSha256: string;
    outputSha256: string;
  }[] = [];
  const contributed = new Set<string>();
  const budget = { mappings: 0, outputBytes: 0, mapBytes: 0 };
  for (const output of evidence.outputs) {
    const absoluteOutput = path.resolve(
      evidence.sourceRoot,
      output.metafilePath,
    );
    within(evidence.outputRoot, absoluteOutput);
    const moduleName = path.relative(evidence.outputRoot, absoluteOutput);
    relative(moduleName);
    assert.ok(
      moduleNames.has(moduleName),
      "Importing output is not registered",
    );
    const info = meta.outputs[output.metafilePath]!;
    assert.ok(
      output.bytes instanceof Uint8Array &&
        output.bytes.length > 0 &&
        output.bytes.length <= MAX_BYTES,
    );
    budget.outputBytes += output.bytes.length;
    assert.ok(
      budget.outputBytes <= 128 * 1024 * 1024,
      "Whole-graph output budget exceeded",
    );
    assert.equal(info.bytes, output.bytes.length);
    assert.equal(output.sourceMap.metafilePath, output.metafilePath + ".map");
    const mapBytes = output.sourceMap.bytes;
    assert.ok(
      mapBytes instanceof Uint8Array &&
        mapBytes.length > 0 &&
        mapBytes.length <= MAX_BYTES,
    );
    budget.mapBytes += mapBytes.length;
    assert.ok(
      budget.mapBytes <= MAX_BYTES,
      "Whole-graph source-map budget exceeded",
    );
    assert.equal(
      meta.outputs[output.sourceMap.metafilePath]?.bytes,
      mapBytes.length,
    );
    const map = JSON.parse(
      Buffer.from(mapBytes).toString("utf8"),
    ) as SourceMapV3;
    assert.equal(map.version, 3);
    assert.ok(map.sourceRoot === undefined || map.sourceRoot === "");
    assert.equal(map.sections, undefined);
    assert.ok(
      Array.isArray(map.sources) &&
        Array.isArray(map.sourcesContent) &&
        Array.isArray(map.names),
    );
    assert.ok(
      map.sources.length <= 8192 &&
        map.sources.length === map.sourcesContent.length,
    );
    assert.equal(typeof map.mappings, "string");
    assert.ok(map.names.every((name) => typeof name === "string"));
    assert.ok(
      map.sources.every(
        (source) => typeof source === "string" && !/[\\\0]/.test(source),
      ),
    );
    assert.ok(
      map.sourcesContent.every(
        (content) => content === null || typeof content === "string",
      ),
    );
    const text = Buffer.from(output.bytes).toString("utf8");
    const mappings = decodeMappings(map, text, budget);
    const sourceIndexes = new Map<string, number>();
    for (const [source, pin] of pins) {
      const expected = new Set([
        path.resolve(evidence.sourceRoot, source),
        path.resolve(
          evidence.dependencyRoot,
          source.slice("node_modules/".length),
        ),
      ]);
      const matches = map.sources.flatMap((name, index) =>
        expected.has(path.resolve(path.dirname(absoluteOutput), name))
          ? [index]
          : [],
      );
      assert.ok(matches.length <= 1, "Duplicate source-map alias");
      const contribution = info.inputs[source]?.bytesInOutput ?? 0;
      assert.ok(Number.isSafeInteger(contribution) && contribution >= 0);
      if (matches.length) {
        assert.equal(typeof map.sourcesContent[matches[0]!], "string");
        assert.equal(
          sha256(map.sourcesContent[matches[0]!]!),
          pin,
          "Source-map content changed",
        );
      }
      if (contribution === 0) continue;
      assert.equal(
        matches.length,
        1,
        "Contributing source absent from associated output map",
      );
      const sourceIndex = matches[0]!;
      assert.ok(
        mappings.some((mapping) => mapping.source === sourceIndex),
        "Source-map content has no generated mapping",
      );
      sourceIndexes.set(source, sourceIndex);
      contributed.add(source);
    }
    assert.ok(Array.isArray(info.imports));
    for (const [index, dependency] of info.imports.entries()) {
      if (dependency.path !== "pg-native") {
        if (dependency.external)
          assert.match(
            dependency.path,
            /^(?:node:|cloudflare:)/,
            "Unreviewed external package",
          );
        continue;
      }
      exactOptional(dependency);
      assert.ok(
        sourceIndexes.has(CLIENT),
        "Optional require lacks matching native-client contribution",
      );
      // Require an actual generated mapping to the exact pinned require line,
      // not merely another statement somewhere in this long native-client file.
      const clientText = Buffer.from(evidence.sources[CLIENT]!).toString(
        "utf8",
      );
      const originalLine = clientText
        .split("\n")
        .findIndex((line) => line.includes("Native = require('pg-native')"));
      assert.ok(originalLine >= 0);
      assert.ok(
        mappings.some(
          (mapping) =>
            mapping.source === sourceIndexes.get(CLIENT) &&
            mapping.originalLine === originalLine,
        ),
        "Optional require statement has no generated mapping",
      );
      const calls = [
        ...text.matchAll(/[$A-Z_a-z][$\w]*\((["'])pg-native\1\)/g),
      ];
      assert.equal(
        calls.length,
        1,
        "Expected one emitted optional require call",
      );
      const call = calls[0]!;
      const prefix = text.slice(0, call.index!);
      const generatedLine = prefix.split("\n").length - 1;
      const generatedColumn = prefix.length - prefix.lastIndexOf("\n") - 1;
      const callEnd = generatedColumn + call[0].length;
      assert.ok(
        mappings.some(
          (mapping) =>
            mapping.line === generatedLine &&
            mapping.column >= generatedColumn &&
            mapping.column < callEnd &&
            mapping.source === sourceIndexes.get(CLIENT) &&
            mapping.originalLine === originalLine,
        ),
        "Emitted require call lacks source-map origin",
      );
      approved.push({
        output: output.metafilePath,
        importIndex: index,
        sourceMapSha256: sha256(mapBytes),
        outputSha256: sha256(output.bytes),
      });
    }
  }
  assert.deepEqual([...contributed].sort(), pins.map(([name]) => name).sort());
  assert.equal(
    approved.length,
    1,
    "Exactly one unresolved optional output require is admitted",
  );
  // Map/Wasm outputs must not smuggle additional external imports past JS checks.
  for (const [name, info] of Object.entries(meta.outputs)) {
    if (name.endsWith(".js")) continue;
    assert.ok(Array.isArray(info.imports));
    assert.ok(
      info.imports.every(
        (dependency) => !dependency.external && dependency.path !== "pg-native",
      ),
    );
  }
  return {
    kind: "source-bound-unresolved-optional-require" as const,
    package: "pg-native" as const,
    universallyClosedGraph: false as const,
    branchInactivityProven: false as const,
    admitted: approved[0]!,
  };
}
