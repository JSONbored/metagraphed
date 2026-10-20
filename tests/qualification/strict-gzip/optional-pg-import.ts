// Proposed test-only metadata validator. Does not load pg, build, resolve, or run code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import path from "node:path";
import { types } from "node:util";
import {
  assertErasureConfigSources,
  assertNoDiscardedInputEvidence,
  isReviewedDiscardedInputTuple,
  proveDiscardedInputBatch,
  type DiscardedInputSource,
  type ErasureConfigSources,
  type PendingDiscardedInput,
} from "./discarded-input-proof.ts";

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

/** Fixed diagnostics only: never stringify a metadata target or scope. */
export function optionalPgExternalRefusalMarker(
  scope: unknown,
  target: unknown,
) {
  const scopeLabel =
    scope === "input" ? "input" : scope === "output" ? "output" : "unknown";
  const packageLabel =
    target === "bufferutil"
      ? "bufferutil"
      : target === "utf-8-validate"
        ? "utf-8-validate"
        : "other";
  return `[owner-optional-import-refused:${scopeLabel}:${packageLabel}]` as const;
}

/** Same existing builtin predicate. pg-native requires its separate proof. */
export function assertOptionalPgExternalImport(
  scope: unknown,
  target: unknown,
): void {
  if (typeof target === "string" && /^(?:node:|cloudflare:)/.test(target))
    return;
  throw new Error(optionalPgExternalRefusalMarker(scope, target));
}

export const OPTIONAL_PROOF_STAGES = Object.freeze([
  "roots",
  "inventory",
  "external-imports",
  "module-inventory",
  "source-identities",
  "input-edges",
  "discarded-inputs",
  "erasure-config",
  "source-pins",
  "pinned-edges",
  "optional-input",
  "output-inventory",
  "output-bytes",
  "source-map",
  "contributions",
  "optional-output",
  "completeness",
] as const);
export const OPTIONAL_IMPORT_CATEGORIES = Object.freeze([
  "pg-native",
  "bufferutil",
  "utf-8-validate",
  "node",
  "cloudflare",
  "other",
] as const);
export const OPTIONAL_PG_DIAGNOSTIC_LIMITS = Object.freeze({
  inputRecords: 8192,
  outputRecords: 1024,
  importsPerScope: 65536,
});
type ProofStage = (typeof OPTIONAL_PROOF_STAGES)[number];
type Category = (typeof OPTIONAL_IMPORT_CATEGORIES)[number];
export interface OptionalPgImportCounts {
  complete: boolean;
  counts: Record<Category, number>;
}
function emptyImportCounts(): OptionalPgImportCounts {
  return {
    complete: false,
    counts: {
      "pg-native": 0,
      bufferutil: 0,
      "utf-8-validate": 0,
      node: 0,
      cloudflare: 0,
      other: 0,
    },
  };
}
function dataProperty(value: unknown, name: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    throw new Error("Malformed diagnostics data");
  const property = Object.getOwnPropertyDescriptor(value, name);
  if (!property) return undefined;
  if (!Object.hasOwn(property, "value"))
    throw new Error("Accessor diagnostics data");
  return property.value;
}
function externalCategory(target: string): Category {
  if (
    target === "pg-native" ||
    target === "bufferutil" ||
    target === "utf-8-validate"
  )
    return target;
  if (target.startsWith("node:")) return "node";
  if (target.startsWith("cloudflare:")) return "cloudflare";
  return "other";
}

/** Failure-only, bounded diagnostics. Incomplete scopes have all-zero counts. */
export function collectOptionalPgExternalImportCounts(metafile: unknown): {
  input: OptionalPgImportCounts;
  output: OptionalPgImportCounts;
} {
  const result = { input: emptyImportCounts(), output: emptyImportCounts() };
  for (const [scope, field, maximumRecords] of [
    ["input", "inputs", OPTIONAL_PG_DIAGNOSTIC_LIMITS.inputRecords],
    ["output", "outputs", OPTIONAL_PG_DIAGNOSTIC_LIMITS.outputRecords],
  ] as const) {
    const count = result[scope];
    try {
      const table = dataProperty(metafile, field);
      if (
        typeof table !== "object" ||
        table === null ||
        types.isProxy(table) ||
        Array.isArray(table)
      )
        continue;
      const keys = Object.keys(table);
      if (keys.length > maximumRecords) continue;
      let scanned = 0;
      for (const key of keys) {
        const imports = dataProperty(dataProperty(table, key), "imports");
        if (
          types.isProxy(imports) ||
          !Array.isArray(imports) ||
          imports.length >
            OPTIONAL_PG_DIAGNOSTIC_LIMITS.importsPerScope - scanned
        )
          throw new Error("Incomplete diagnostics scan");
        for (let index = 0; index < imports.length; index++) {
          // Do not run accessors, stringify targets, or inspect error values.
          const descriptor = Object.getOwnPropertyDescriptor(
            imports,
            String(index),
          );
          if (!descriptor || !Object.hasOwn(descriptor, "value"))
            throw new Error("Malformed import array");
          const item = descriptor.value;
          const external = dataProperty(item, "external");
          const target = dataProperty(item, "path");
          if (
            (external !== undefined &&
              external !== false &&
              external !== true) ||
            typeof target !== "string"
          )
            throw new Error("Malformed import metadata");
          scanned++;
          if (external === true) count.counts[externalCategory(target)]++;
        }
      }
      count.complete = true;
    } catch {
      // Diagnostic failure cannot replace or change the original proof failure.
    }
    if (!count.complete) result[scope] = emptyImportCounts();
  }
  return result;
}
function countMarker(
  scope: "input" | "output",
  value: OptionalPgImportCounts,
): string {
  return `[owner-optional-import-counts:${scope}:${value.complete ? 1 : 0}:${OPTIONAL_IMPORT_CATEGORIES.map((category) => value.counts[category]).join(":")}]`;
}

const optionalProofDiagnosticMessages = new WeakMap<object, string>();
/** Only messages branded by this validator; arbitrary errors are never read. */
export function optionalProofDiagnosticMarkers(error: unknown): string {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return "";
  return optionalProofDiagnosticMessages.get(error as object) ?? "";
}

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
  // Separate exact source/config custody for the fixed reviewed discarded batch.
  discardedInputSources?: Readonly<Record<string, Uint8Array>>;
  erasureConfigSources?: ErasureConfigSources;
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
  assert.ok(
    value.length > 1 &&
      value.length <= 4096 &&
      !/[\\\0-\x1f:]/.test(value) &&
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      path.resolve(value) === value,
  );
}

/**
 * Map a genuine esbuild file-input key to one logical custody identity.
 * The caller establishes these exact roots with realpath and enforces them on
 * file reads. This lexical helper cannot authenticate roots or follow symlinks.
 * esbuild's preserveSymlinks=false can emit a canonical dependency-root path
 * relative to sourceRoot; preserve that actual key instead of rewriting it.
 */
export function ownerSourceIdentity(
  sourceRoot: string,
  dependencyRoot: string,
  metafilePath: string,
): string {
  absolute(sourceRoot);
  absolute(dependencyRoot);
  assert.ok(
    sourceRoot !== dependencyRoot &&
      !sourceRoot.startsWith(dependencyRoot + path.sep),
    "Dependency root cannot contain the project root",
  );
  assert.equal(typeof metafilePath, "string");
  assert.ok(
    metafilePath.length > 0 &&
      metafilePath.length <= 4096 &&
      !path.isAbsolute(metafilePath) &&
      !/[\\\0-\x1f:]/.test(metafilePath),
    "Expected a genuine relative file-input key",
  );
  const resolved = path.resolve(sourceRoot, metafilePath);
  assert.equal(
    path.relative(sourceRoot, resolved),
    metafilePath,
    "Noncanonical file-input spelling",
  );
  if (resolved.startsWith(dependencyRoot + path.sep)) {
    const relativeDependency = path.relative(dependencyRoot, resolved);
    relative(relativeDependency);
    return `node_modules/${relativeDependency}`;
  }
  within(sourceRoot, resolved);
  const logical = path.relative(sourceRoot, resolved);
  relative(logical);
  return logical;
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
  let stage: ProofStage = "roots";
  try {
    for (const root of [
      evidence.sourceRoot,
      evidence.dependencyRoot,
      evidence.outputRoot,
    ])
      absolute(root);
    stage = "inventory";
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
    stage = "external-imports";
    let mentionsOptional = false;
    const pendingDiscarded: PendingDiscardedInput[] = [];
    for (const info of Object.values(meta.outputs))
      assert.ok(Array.isArray(info.imports));
    for (const { scope, name, info } of [
      ...Object.entries(meta.inputs).map(([name, info]) => ({
        scope: "input",
        name,
        info,
      })),
      ...Object.entries(meta.outputs).map(([name, info]) => ({
        scope: "output",
        name,
        info,
      })),
    ]) {
      // Legacy synthetic no-exception graphs omit input import arrays. They can
      // return null, but can never establish an optional-import exception.
      assert.ok(info.imports === undefined || Array.isArray(info.imports));
      for (const [index, dependency] of (info.imports ?? []).entries()) {
        assert.equal(typeof dependency.path, "string");
        assert.ok(
          !suppliedNative(dependency.path) || dependency.path === "pg-native",
          "Supplied native dependency is forbidden",
        );
        if (dependency.external && dependency.path !== "pg-native") {
          let reviewed = false;
          if (
            scope === "input" &&
            !/^(?:node:|cloudflare:)/.test(dependency.path)
          ) {
            try {
              const logical = ownerSourceIdentity(
                evidence.sourceRoot,
                evidence.dependencyRoot,
                name,
              );
              reviewed = isReviewedDiscardedInputTuple(
                logical,
                index,
                dependency,
              );
            } catch {
              /* An unknown input retains the original refusal path. */
            }
          }
          if (reviewed)
            pendingDiscarded.push({ actual: name, importIndex: index });
          else assertOptionalPgExternalImport(scope, dependency.path);
        }
        if (
          dependency.path === "pg-native" ||
          dependency.original === "pg-native"
        )
          mentionsOptional = true;
      }
    }
    stage = "module-inventory";
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
    if (!mentionsOptional) {
      assert.equal(
        pendingDiscarded.length,
        0,
        "Discarded records require the complete optional pg proof",
      );
      assertNoDiscardedInputEvidence(evidence);
      return null;
    }
    for (const info of Object.values(meta.inputs))
      assert.ok(Array.isArray(info.imports), "Missing input import provenance");
    stage = "output-inventory";
    const executableModuleNames = outputNames
      .filter((name) => !name.endsWith(".map"))
      .map((name) => {
        const absoluteOutput = path.resolve(evidence.sourceRoot, name);
        within(evidence.outputRoot, absoluteOutput);
        assert.ok(name.endsWith(".js") || name.endsWith(".wasm"));
        return path.relative(evidence.outputRoot, absoluteOutput);
      });
    assert.deepEqual([...moduleNames].sort(), executableModuleNames.sort());
    stage = "source-identities";
    const pins = Object.entries(OPTIONAL_PG_SOURCE_PINS);
    const actualInputs = new Map<string, string>();
    for (const actual of inputNames) {
      if (actual.startsWith("native-node-require:")) {
        assert.match(actual, /^native-node-require:[A-Za-z0-9_/-]+$/);
        assert.ok(isBuiltin(actual.slice("native-node-require:".length)));
        continue;
      }
      const logical = ownerSourceIdentity(
        evidence.sourceRoot,
        evidence.dependencyRoot,
        actual,
      );
      assert.ok(
        !actualInputs.has(logical),
        "Duplicate logical/canonical input alias",
      );
      actualInputs.set(logical, actual);
    }
    stage = "input-edges";
    for (const info of Object.values(meta.inputs)) {
      for (const item of info.imports) {
        if (item.external === true) continue;
        assert.ok(
          Object.hasOwn(meta.inputs, item.path),
          "Internal edge has no exact input key",
        );
        if (item.path.startsWith("native-node-require:")) continue;
        const logical = ownerSourceIdentity(
          evidence.sourceRoot,
          evidence.dependencyRoot,
          item.path,
        );
        assert.equal(
          actualInputs.get(logical),
          item.path,
          "Internal edge uses an input identity alias",
        );
      }
    }
    let discardedSources: ReadonlyMap<string, DiscardedInputSource> = new Map();
    if (pendingDiscarded.length) {
      stage = "erasure-config";
      assertErasureConfigSources(evidence);
      stage = "discarded-inputs";
      discardedSources = proveDiscardedInputBatch(
        evidence,
        actualInputs,
        pendingDiscarded,
      );
    } else {
      assertNoDiscardedInputEvidence(evidence);
    }
    stage = "source-pins";
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
      const actual = actualInputs.get(name);
      assert.ok(actual, "Unique pinned input identity absent");
      assert.equal(meta.inputs[actual]!.bytes, bytes.length);
    }
    stage = "pinned-edges";
    const edges = [
      [ESM, MAIN, "import-statement"],
      [MAIN, NATIVE_INDEX, "require-call"],
      [NATIVE_INDEX, CLIENT, "require-call"],
    ];
    for (const [from, to, kind] of edges) {
      assert.ok(
        meta.inputs[actualInputs.get(from!)!]!.imports.some(
          (item) =>
            item.path === actualInputs.get(to!) &&
            item.kind === kind &&
            item.external !== true,
        ),
        "Pinned native branch association absent",
      );
    }
    stage = "optional-input";
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
            actualInputs.get(CLIENT),
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

    stage = "output-inventory";
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
      stage = "output-inventory";
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
      // Output contributions must use the same actual input keys as the complete
      // input inventory. A second logical/canonical spelling is not a new source.
      stage = "contributions";
      const contributionIdentities = new Set<string>();
      for (const actual of Object.keys(info.inputs)) {
        assert.ok(
          Object.hasOwn(meta.inputs, actual),
          "Output contribution has no exact input key",
        );
        if (actual.startsWith("native-node-require:")) continue;
        const logical = ownerSourceIdentity(
          evidence.sourceRoot,
          evidence.dependencyRoot,
          actual,
        );
        assert.equal(actualInputs.get(logical), actual);
        assert.ok(
          !contributionIdentities.has(logical),
          "Duplicate contribution alias",
        );
        contributionIdentities.add(logical);
      }
      stage = "output-bytes";
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
      stage = "source-map";
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
      stage = "source-map";
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
      stage = "contributions";
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
        const contribution =
          info.inputs[actualInputs.get(source)!]?.bytesInOutput ?? 0;
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
      for (const [source, proved] of discardedSources) {
        const expected = path.resolve(evidence.sourceRoot, source);
        const matches = map.sources.flatMap((name, index) =>
          path.resolve(path.dirname(absoluteOutput), name) === expected
            ? [index]
            : [],
        );
        assert.ok(
          matches.length <= 1,
          "Duplicate discarded importer map alias",
        );
        const contribution = info.inputs[proved.actual]?.bytesInOutput ?? 0;
        assert.ok(Number.isSafeInteger(contribution) && contribution >= 0);
        if (matches.length) {
          const content = map.sourcesContent[matches[0]!];
          assert.equal(typeof content, "string");
          assert.equal(
            Buffer.byteLength(content!),
            proved.bytes,
            "Discarded importer map byte count changed",
          );
          assert.equal(
            sha256(content!),
            proved.sha256,
            "Discarded importer map source changed",
          );
        }
        if (contribution === 0) continue;
        assert.equal(
          matches.length,
          1,
          "Contributing discarded importer absent from map",
        );
        assert.ok(
          mappings.some((mapping) => mapping.source === matches[0]),
          "Discarded importer has no genuine mapping",
        );
      }
      stage = "optional-output";
      assert.ok(Array.isArray(info.imports));
      for (const [index, dependency] of info.imports.entries()) {
        if (dependency.path !== "pg-native") {
          if (dependency.external)
            assertOptionalPgExternalImport("output", dependency.path);
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
    stage = "completeness";
    assert.ok(
      pendingDiscarded.length === 0 || discardedSources.size === 20,
      "Incomplete discarded-input proof",
    );
    assert.deepEqual(
      [...contributed].sort(),
      pins.map(([name]) => name).sort(),
    );
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
          (dependency) =>
            !dependency.external && dependency.path !== "pg-native",
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
  } catch (cause) {
    // Scan only after the proof has already failed. Never retry or bypass it.
    let counts = { input: emptyImportCounts(), output: emptyImportCounts() };
    try {
      counts = collectOptionalPgExternalImportCounts(
        dataProperty(evidence, "metafile"),
      );
    } catch {
      /* Retain incomplete fixed diagnostics. */
    }
    const markers = [
      `[owner-optional-proof-failed:${stage}]`,
      countMarker("input", counts.input),
      countMarker("output", counts.output),
    ];
    // Never inspect the original error. Preserve it untouched as cause.
    const message = markers.join("\n");
    const wrapped = new Error(message, { cause });
    optionalProofDiagnosticMessages.set(wrapped, message);
    throw wrapped;
  }
}
