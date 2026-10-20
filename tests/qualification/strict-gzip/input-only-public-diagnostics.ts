// Diagnostic data only. This helper cannot authorize an import or alter a proof.
import { createHash } from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import { ownerSourceIdentity } from "./optional-pg-import.ts";

export const PUBLIC_INPUT_ONLY_KINDS = Object.freeze([
  "import-statement",
  "require-call",
  "dynamic-import",
  "require-resolve",
] as const);
export const PUBLIC_INPUT_ONLY_LIMITS = Object.freeze({
  inputRecords: 8192,
  outputRecords: 1024,
  indexRecords: 8192,
  importsPerScope: 65536,
  targetCharacters: 4096,
  targetCharactersPerScope: 16 * 1024 * 1024,
  publicPathCharacters: 512,
  sourceBytes: 2 * 1024 * 1024,
  totalSourceBytes: 32 * 1024 * 1024,
  records: 64,
  literalLocations: 3,
  line: 99999,
  column: 9999,
  serializedCharacters: 56000,
});
export const PUBLIC_INPUT_ONLY_REFUSALS = Object.freeze([
  "unindexed",
  "missingSource",
  "sourceMismatch",
  "unsupportedKind",
  "ambiguousSource",
  "noLiteral",
  "tooManyLiterals",
  "malformed",
  "emittedTarget",
] as const);
type Kind = (typeof PUBLIC_INPUT_ONLY_KINDS)[number];
type Refusal = (typeof PUBLIC_INPUT_ONLY_REFUSALS)[number];
export interface PublicSourcePin {
  readonly path: string;
  readonly gitBlob: string;
}
export interface InputOnlyPublicEvidence {
  metafile: unknown;
  sourceRoot: string;
  dependencyRoot: string;
  // Caller authenticates this complete index against its pinned public tree.
  // Both the array and each {path, gitBlob} row must be frozen data objects.
  publicSources: readonly PublicSourcePin[];
  // Canonical, bounded caller reads keyed only by verified public source paths.
  // The caller must check exact realpath custody; this helper performs no IO.
  sourceBytes: Readonly<Record<string, Uint8Array>>;
}
export interface InputOnlyPublicRecord {
  sourcePath: string;
  gitBlob: string;
  importIndex: number;
  kind: Kind;
  // One-based UTF-16 positions of opening quotes in exact textual occurrences.
  // They are review locations, never syntax classification or erasure proof.
  literalLocations: { line: number; column: number }[];
}
export interface InputOnlyPublicDiagnostics {
  version: 1;
  inputScanComplete: boolean;
  outputScanComplete: boolean;
  complete: boolean;
  candidateCount: number;
  identifiedCount: number;
  refusedCount: number;
  overflowCount: number;
  refused: Record<Refusal, number>;
  records: InputOnlyPublicRecord[];
}
interface Candidate {
  key: string;
  bytes: number;
  importIndex: number;
  kind: string;
  target: string;
}
interface Scan {
  complete: boolean;
  candidates: Candidate[];
  inputKeys: string[];
  outputPaths: Set<string>;
}
const fail = (): never => {
  throw new Error("Incomplete public source diagnostics");
};
function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail();
  return value as Record<string, unknown>;
}
function own(value: unknown, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record(value), name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) return fail();
  return descriptor.value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value)) return fail();
  if (value.length > maximum) return fail();
  return value;
}
function item(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
  return descriptor.value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum)
    return fail();
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    return fail();
  return value;
}
function publicPath(value: unknown): string {
  const path = text(value, PUBLIC_INPUT_ONLY_LIMITS.publicPathCharacters);
  if (
    !/^[A-Za-z0-9_@.$\[\]/-]+$/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === "node_modules" ||
          part === ".git",
      )
  )
    return fail();
  return path;
}
function exactKeys(value: unknown, names: readonly string[]): void {
  const object = record(value);
  const keys = Reflect.ownKeys(object);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    fail();
  for (const name of names) own(object, name);
}
function exactArray(value: unknown, maximum: number): unknown[] {
  const values = array(value, maximum);
  if (Reflect.ownKeys(values).length !== values.length + 1) fail();
  for (let n = 0; n < values.length; n++) item(values, n);
  return values;
}
function tableKeys(value: Record<string, unknown>, maximum: number): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) return fail();
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      return fail();
    result.push(key);
  }
  return result;
}
function verifiedIndex(value: unknown): Map<string, string> {
  const pins = exactArray(value, PUBLIC_INPUT_ONLY_LIMITS.indexRecords);
  if (!Object.isFrozen(pins)) fail();
  const index = new Map<string, string>();
  for (let n = 0; n < pins.length; n++) {
    const pin = record(item(pins, n));
    exactKeys(pin, ["path", "gitBlob"]);
    if (!Object.isFrozen(pin)) fail();
    const path = publicPath(own(pin, "path"));
    const gitBlob = own(pin, "gitBlob");
    if (
      typeof gitBlob !== "string" ||
      !/^[a-f0-9]{40}$/.test(gitBlob) ||
      index.has(path)
    )
      fail();
    index.set(path, gitBlob as string);
  }
  return index;
}
function sourceIdentities(
  sourceRoot: string,
  dependencyRoot: string,
  keys: readonly string[],
) {
  const identities = new Map<string, string | null>();
  const multiplicity = new Map<string, number>();
  for (const key of keys) {
    try {
      const identity = ownerSourceIdentity(sourceRoot, dependencyRoot, key);
      identities.set(key, identity);
      multiplicity.set(identity, (multiplicity.get(identity) ?? 0) + 1);
    } catch {
      identities.set(key, null);
      // Never identify an alias, but let its normalized in-root identity poison
      // a competing canonical key instead of silently selecting that key.
      try {
        const normalized = path.relative(
          sourceRoot,
          path.resolve(sourceRoot, key),
        );
        const identity = ownerSourceIdentity(
          sourceRoot,
          dependencyRoot,
          normalized,
        );
        multiplicity.set(identity, (multiplicity.get(identity) ?? 0) + 1);
      } catch {
        /* Unknown namespace/out-of-root input has no public identity. */
      }
    }
  }
  return { identities, multiplicity };
}
function empty(): InputOnlyPublicDiagnostics {
  return {
    version: 1,
    inputScanComplete: false,
    outputScanComplete: false,
    complete: false,
    candidateCount: 0,
    identifiedCount: 0,
    refusedCount: 0,
    overflowCount: 0,
    refused: {
      unindexed: 0,
      missingSource: 0,
      sourceMismatch: 0,
      unsupportedKind: 0,
      ambiguousSource: 0,
      noLiteral: 0,
      tooManyLiterals: 0,
      malformed: 0,
      emittedTarget: 0,
    },
    records: [],
  };
}
function scan(metafile: unknown, scope: "inputs" | "outputs"): Scan {
  const result: Scan = {
    complete: false,
    candidates: [],
    inputKeys: [],
    outputPaths: new Set(),
  };
  try {
    const table = record(own(metafile, scope));
    const keys = tableKeys(
      table,
      scope === "inputs"
        ? PUBLIC_INPUT_ONLY_LIMITS.inputRecords
        : PUBLIC_INPUT_ONLY_LIMITS.outputRecords,
    );
    let count = 0;
    let characters = 0;
    for (const key of keys) {
      text(key, PUBLIC_INPUT_ONLY_LIMITS.targetCharacters);
      const entry = own(table, key);
      const bytes = integer(own(entry, "bytes"), Number.MAX_SAFE_INTEGER);
      const imports = array(
        own(entry, "imports"),
        PUBLIC_INPUT_ONLY_LIMITS.importsPerScope - count,
      );
      if (scope === "inputs") result.inputKeys.push(key);
      for (let index = 0; index < imports.length; index++) {
        const imported = item(imports, index);
        const target = text(
          own(imported, "path"),
          PUBLIC_INPUT_ONLY_LIMITS.targetCharacters,
        );
        const kind = text(own(imported, "kind"), 64);
        const external = own(imported, "external");
        const original = own(imported, "original");
        if (external !== undefined && external !== false && external !== true)
          fail();
        if (original !== undefined)
          text(original, PUBLIC_INPUT_ONLY_LIMITS.targetCharacters);
        characters += target.length;
        if (characters > PUBLIC_INPUT_ONLY_LIMITS.targetCharactersPerScope)
          fail();
        count++;
        if (scope === "outputs") result.outputPaths.add(target);
        else if (
          external === true &&
          target !== "pg-native" &&
          !/^(?:node:|cloudflare:)/.test(target)
        )
          result.candidates.push({
            key,
            bytes,
            importIndex: index,
            kind,
            target,
          });
      }
    }
    result.complete = true;
  } catch {
    result.candidates = [];
    result.inputKeys = [];
    result.outputPaths.clear();
  }
  return result;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
function snapshot(value: unknown): Uint8Array {
  if (types.isProxy(value) || !types.isUint8Array(value)) return fail();
  const length = integer(
    byteLength.call(value),
    PUBLIC_INPUT_ONLY_LIMITS.sourceBytes,
  );
  if (types.isSharedArrayBuffer(arrayBuffer.call(value))) return fail();
  const copy = new Uint8Array(length);
  // The intrinsic typed-array operation reads internal slots, not user getters.
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}
function blob(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}
function locations(
  source: string,
  target: string,
): { reason?: Refusal; values: { line: number; column: number }[] } {
  if (/[\\\x00-\x1f\x7f\u2028\u2029]/.test(target))
    return { reason: "noLiteral", values: [] };
  const offsets: number[] = [];
  for (const quote of ["'", '"']) {
    if (target.includes(quote)) continue;
    const needle = quote + target + quote;
    let offset = source.indexOf(needle);
    while (offset >= 0) {
      let slashes = 0;
      for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
      if (slashes % 2 === 0) offsets.push(offset);
      if (offsets.length > PUBLIC_INPUT_ONLY_LIMITS.literalLocations)
        return { reason: "tooManyLiterals", values: [] };
      offset = source.indexOf(needle, offset + needle.length);
    }
  }
  if (!offsets.length) return { reason: "noLiteral", values: [] };
  offsets.sort((a, b) => a - b);
  let line = 1,
    column = 1,
    cursor = 0;
  const values: { line: number; column: number }[] = [];
  for (const offset of offsets) {
    while (cursor < offset) {
      const character = source[cursor++];
      if (character === "\r") {
        if (source[cursor] === "\n") cursor++;
        line++;
        column = 1;
      } else if (
        character === "\n" ||
        character === "\u2028" ||
        character === "\u2029"
      ) {
        line++;
        column = 1;
      } else column++;
    }
    if (
      line > PUBLIC_INPUT_ONLY_LIMITS.line ||
      column > PUBLIC_INPUT_ONLY_LIMITS.column
    )
      return { reason: "malformed", values: [] };
    values.push({ line, column });
  }
  return { values };
}

/**
 * Failure-only public-source identification. Never use this return value to
 * accept a build. Scans are independent and complete before any identification.
 * Refusal/overflow counts partition fully scanned candidates with identifiedCount.
 * An incomplete input scan has no candidate count; an incomplete output scan
 * refuses all fully scanned input candidates as malformed. No arbitrary error
 * or metadata value is stringified or returned.
 */
export function identifyInputOnlyPublicImports(
  evidence: InputOnlyPublicEvidence,
): InputOnlyPublicDiagnostics {
  const result = empty();
  let inputs: Scan;
  let outputs: Scan;
  try {
    const metafile = own(evidence, "metafile");
    inputs = scan(metafile, "inputs");
    outputs = scan(metafile, "outputs");
  } catch {
    return result;
  }
  result.inputScanComplete = inputs.complete;
  result.outputScanComplete = outputs.complete;
  if (!inputs.complete) return result;
  result.candidateCount = inputs.candidates.length;
  const refuse = (reason: Refusal, count = 1) => {
    result.refused[reason] += count;
    result.refusedCount += count;
  };
  if (!outputs.complete) {
    refuse("malformed", result.candidateCount);
    return result;
  }
  try {
    const sourceRoot = text(own(evidence, "sourceRoot"), 4096);
    const dependencyRoot = text(own(evidence, "dependencyRoot"), 4096);
    // Validate roots even for an empty graph, without inventing a source identity.
    ownerSourceIdentity(
      sourceRoot,
      dependencyRoot,
      "__public_diagnostic_root_check__",
    );
    const index = verifiedIndex(own(evidence, "publicSources"));
    const supplied = record(own(evidence, "sourceBytes"));
    const suppliedKeys = tableKeys(
      supplied,
      PUBLIC_INPUT_ONLY_LIMITS.indexRecords,
    );
    const sources = new Map<
      string,
      { bytes: number; gitBlob: string; text: string } | null
    >();
    let totalBytes = 0;
    for (const key of suppliedKeys) {
      if (!index.has(key)) fail();
      const bytes = snapshot(own(supplied, key));
      totalBytes += bytes.byteLength;
      if (totalBytes > PUBLIC_INPUT_ONLY_LIMITS.totalSourceBytes) fail();
      try {
        sources.set(key, {
          bytes: bytes.byteLength,
          gitBlob: blob(bytes),
          text: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
        });
      } catch {
        sources.set(key, null);
      }
    }
    const { identities, multiplicity } = sourceIdentities(
      sourceRoot,
      dependencyRoot,
      inputs.inputKeys,
    );
    // Bound expensive source matching separately from the complete metadata scan.
    result.overflowCount = Math.max(
      0,
      inputs.candidates.length - PUBLIC_INPUT_ONLY_LIMITS.records,
    );
    for (const candidate of inputs.candidates.slice(
      0,
      PUBLIC_INPUT_ONLY_LIMITS.records,
    )) {
      const identity = identities.get(candidate.key);
      if (outputs.outputPaths.has(candidate.target)) {
        refuse("emittedTarget");
        continue;
      }
      if (!PUBLIC_INPUT_ONLY_KINDS.some((kind) => kind === candidate.kind)) {
        refuse("unsupportedKind");
        continue;
      }
      if (!identity || !index.has(identity)) {
        refuse("unindexed");
        continue;
      }
      if (multiplicity.get(identity) !== 1) {
        refuse("ambiguousSource");
        continue;
      }
      if (!sources.has(identity)) {
        refuse("missingSource");
        continue;
      }
      const source = sources.get(identity);
      const gitBlob = index.get(identity)!;
      if (
        !source ||
        source.gitBlob !== gitBlob ||
        source.bytes !== candidate.bytes
      ) {
        refuse("sourceMismatch");
        continue;
      }
      const found = locations(source.text, candidate.target);
      if (found.reason) {
        refuse(found.reason);
        continue;
      }
      result.records.push({
        sourcePath: identity,
        gitBlob,
        importIndex: candidate.importIndex,
        kind: candidate.kind as Kind,
        literalLocations: found.values,
      });
      result.identifiedCount++;
    }
    result.complete = result.refusedCount === 0 && result.overflowCount === 0;
  } catch {
    // This helper never replaces an existing failure and never exposes its cause.
    result.records = [];
    result.identifiedCount = 0;
    result.overflowCount = 0;
    for (const reason of PUBLIC_INPUT_ONLY_REFUSALS) result.refused[reason] = 0;
    result.refusedCount = 0;
    refuse("malformed", result.candidateCount);
  }
  return result;
}

export type InputOnlyPublicSelectionEvidence = Omit<
  InputOnlyPublicEvidence,
  "sourceBytes"
>;
/** Only indexed public paths for bounded caller reads; never target/raw key data. */
export function selectInputOnlyPublicSourcePaths(
  evidence: InputOnlyPublicSelectionEvidence,
): string[] {
  try {
    const metafile = own(evidence, "metafile");
    const inputs = scan(metafile, "inputs");
    const outputs = scan(metafile, "outputs");
    if (
      !inputs.complete ||
      !outputs.complete ||
      inputs.candidates.length > PUBLIC_INPUT_ONLY_LIMITS.records
    )
      return [];
    const sourceRoot = text(own(evidence, "sourceRoot"), 4096);
    const dependencyRoot = text(own(evidence, "dependencyRoot"), 4096);
    ownerSourceIdentity(
      sourceRoot,
      dependencyRoot,
      "__public_diagnostic_root_check__",
    );
    const index = verifiedIndex(own(evidence, "publicSources"));
    const { identities, multiplicity } = sourceIdentities(
      sourceRoot,
      dependencyRoot,
      inputs.inputKeys,
    );
    const selected = new Set<string>();
    for (const candidate of inputs.candidates) {
      const identity = identities.get(candidate.key);
      if (
        identity &&
        index.has(identity) &&
        multiplicity.get(identity) === 1 &&
        PUBLIC_INPUT_ONLY_KINDS.some((kind) => kind === candidate.kind) &&
        !outputs.outputPaths.has(candidate.target)
      )
        selected.add(identity);
    }
    return [...selected].sort();
  } catch {
    return [];
  }
}

/**
 * Reconstruct only the public diagnostic schema after JSON/log transport.
 * Membership is checked against the same caller-authenticated immutable index.
 * This cannot authenticate a build, source read, metadata file, or proof result.
 */
export function revalidateInputOnlyPublicDiagnostics(
  value: unknown,
  publicSources: readonly PublicSourcePin[],
): InputOnlyPublicDiagnostics | null {
  try {
    const index = verifiedIndex(publicSources);
    exactKeys(value, [
      "version",
      "inputScanComplete",
      "outputScanComplete",
      "complete",
      "candidateCount",
      "identifiedCount",
      "refusedCount",
      "overflowCount",
      "refused",
      "records",
    ]);
    if (own(value, "version") !== 1) return null;
    const result = empty();
    for (const key of [
      "inputScanComplete",
      "outputScanComplete",
      "complete",
    ] as const) {
      const flag = own(value, key);
      if (typeof flag !== "boolean") return null;
      result[key] = flag;
    }
    for (const key of [
      "candidateCount",
      "identifiedCount",
      "refusedCount",
      "overflowCount",
    ] as const)
      result[key] = integer(
        own(value, key),
        PUBLIC_INPUT_ONLY_LIMITS.importsPerScope,
      );
    const refused = own(value, "refused");
    exactKeys(refused, PUBLIC_INPUT_ONLY_REFUSALS);
    for (const key of PUBLIC_INPUT_ONLY_REFUSALS)
      result.refused[key] = integer(
        own(refused, key),
        PUBLIC_INPUT_ONLY_LIMITS.importsPerScope,
      );
    if (
      PUBLIC_INPUT_ONLY_REFUSALS.reduce(
        (sum, key) => sum + result.refused[key],
        0,
      ) !== result.refusedCount ||
      result.identifiedCount + result.refusedCount + result.overflowCount !==
        result.candidateCount
    )
      return null;
    const records = exactArray(
      own(value, "records"),
      PUBLIC_INPUT_ONLY_LIMITS.records,
    );
    if (records.length !== result.identifiedCount) return null;
    const identities = new Set<string>();
    for (let n = 0; n < records.length; n++) {
      const entry = item(records, n);
      exactKeys(entry, [
        "sourcePath",
        "gitBlob",
        "importIndex",
        "kind",
        "literalLocations",
      ]);
      const sourcePath = publicPath(own(entry, "sourcePath"));
      const gitBlob = own(entry, "gitBlob");
      if (!index.has(sourcePath) || index.get(sourcePath) !== gitBlob)
        return null;
      const importIndex = integer(
        own(entry, "importIndex"),
        PUBLIC_INPUT_ONLY_LIMITS.importsPerScope - 1,
      );
      const key = sourcePath + "\0" + importIndex;
      if (identities.has(key)) return null;
      identities.add(key);
      const kind = own(entry, "kind");
      if (!PUBLIC_INPUT_ONLY_KINDS.some((candidate) => candidate === kind))
        return null;
      const locations = exactArray(
        own(entry, "literalLocations"),
        PUBLIC_INPUT_ONLY_LIMITS.literalLocations,
      );
      if (!locations.length) return null;
      const literalLocations: { line: number; column: number }[] = [];
      for (let i = 0; i < locations.length; i++) {
        const location = item(locations, i);
        exactKeys(location, ["line", "column"]);
        const line = integer(
          own(location, "line"),
          PUBLIC_INPUT_ONLY_LIMITS.line,
        );
        const column = integer(
          own(location, "column"),
          PUBLIC_INPUT_ONLY_LIMITS.column,
        );
        const previous = literalLocations.at(-1);
        if (
          !line ||
          !column ||
          (previous &&
            (line < previous.line ||
              (line === previous.line && column <= previous.column)))
        )
          return null;
        literalLocations.push({ line, column });
      }
      result.records.push({
        sourcePath,
        gitBlob: gitBlob as string,
        importIndex,
        kind: kind as Kind,
        literalLocations,
      });
    }
    if (!result.inputScanComplete && result.candidateCount !== 0) return null;
    if (!result.inputScanComplete || !result.outputScanComplete) {
      if (
        result.complete ||
        result.identifiedCount ||
        result.overflowCount ||
        result.refused.malformed !== result.candidateCount
      )
        return null;
    }
    if (
      result.complete &&
      (!result.inputScanComplete ||
        !result.outputScanComplete ||
        result.refusedCount ||
        result.overflowCount)
    )
      return null;
    if (
      !result.complete &&
      result.candidateCount > 0 &&
      result.identifiedCount === result.candidateCount
    )
      return null;
    if (
      result.overflowCount &&
      (result.overflowCount !==
        Math.max(0, result.candidateCount - PUBLIC_INPUT_ONLY_LIMITS.records) ||
        result.identifiedCount + result.refusedCount !==
          PUBLIC_INPUT_ONLY_LIMITS.records)
    )
      return null;
    if (
      JSON.stringify(result).length >
      PUBLIC_INPUT_ONLY_LIMITS.serializedCharacters
    )
      return null;
    return result;
  } catch {
    return null;
  }
}
