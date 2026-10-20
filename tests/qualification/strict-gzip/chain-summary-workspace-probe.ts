// Failure-only identity observation. Never admits an input or changes build policy.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { types } from "node:util";
import { ownerSourceIdentity } from "./optional-pg-import.ts";

export const CHAIN_SUMMARY_WORKSPACE_STATUSES = Object.freeze([
  "identified",
  "no-match",
  "scan-refused",
  "key-refused",
  "link-refused",
  "pin-refused",
  "read-refused",
  "edge-refused",
] as const);
export const CHAIN_SUMMARY_WORKSPACE_LIMITS = Object.freeze({
  inputs: 8192,
  keyCharacters: 4096,
  keyCharactersTotal: 16 * 1024 * 1024,
  imports: 65536,
  targetCharacters: 4096,
  targetCharactersTotal: 16 * 1024 * 1024,
  fields: 16,
  pathSegments: 64,
  fileBytes: 1024 * 1024,
  allFileBytes: 2 * 1024 * 1024,
  markerCharacters: 65536,
});
const rawPins = {
  "package.json": {
    bytes: 16154,
    sha256: "4fb747252be82015272e8fbbb7393a691eea17b21fa01e753d1b9c1b48ecb8bd",
    gitBlob: "343585bc503509c335f39baa74cb60b33352ad10",
  },
  "package-lock.json": {
    bytes: 633552,
    sha256: "8082ef81ed8d765c977314cf17bb77946043a0d8a8ec2668a660b3c4d756f7eb",
    gitBlob: "5b0282bb9e45bab1fd38e28725d7f87ea6bb6ad8",
  },
  "packages/chain-summaries/package.json": {
    bytes: 1258,
    sha256: "866595a6350b7519820d06a75b8a868b2944775deabba077559ae82390ad4c82",
    gitBlob: "75810384d47e30481746b97910e6943357aa96f4",
  },
  "packages/chain-summaries/dist/index.js": {
    bytes: 31640,
    sha256: "196d83987a00f8d68c3888b6f3bef917c13c9300c22dbbc2a0a22a4c55011131",
    gitBlob: "75dda6fbb5ab18adaea081c4fe2a44a08dd1095d",
  },
  "src/extrinsics.ts": {
    bytes: 21641,
    sha256: "82a3d1d66303c70e1ca5c99eceeeb046dea48c4ff25fe5b0ead8fb3c6041af50",
    gitBlob: "579db43b78c61abdfe83665d7d59f19c0b999712",
  },
  "src/chain-detail-hot-tier.ts": {
    bytes: 37552,
    sha256: "7292a1a9a5bd192c96a931e08f0b65857978e1d09f25c06232776db45037da8d",
    gitBlob: "eda90193e3f247be0aea7e866a1944e891f8a727",
  },
} as const;
export const CHAIN_SUMMARY_WORKSPACE_PINS = Object.freeze(
  Object.fromEntries(
    Object.entries(rawPins).map(([name, pin]) => [name, Object.freeze(pin)]),
  ),
) as Readonly<typeof rawPins>;
const DIST = "packages/chain-summaries/dist/index.js";
const PACKAGE = "@jsonbored/chain-summaries";
const EDGES = Object.freeze([
  Object.freeze({ source: "src/extrinsics.ts", index: 8 }),
  Object.freeze({ source: "src/chain-detail-hot-tier.ts", index: 10 }),
] as const);
type Status = (typeof CHAIN_SUMMARY_WORKSPACE_STATUSES)[number];
export interface ChainSummaryWorkspaceReport {
  version: 1;
  identity: "chain-summaries-dist";
  status: Status;
  inputScanComplete: boolean;
  inputCount: number;
  escapedCount: number;
  exactMatches: number;
  otherEscapedCount: number;
  matchedEdges: number;
}
function empty(): ChainSummaryWorkspaceReport {
  return {
    version: 1,
    identity: "chain-summaries-dist",
    status: "scan-refused",
    inputScanComplete: false,
    inputCount: 0,
    escapedCount: 0,
    exactMatches: 0,
    otherEscapedCount: 0,
    matchedEdges: 0,
  };
}
function need(value: unknown): asserts value {
  if (!value) throw new Error("Workspace probe refused");
}
function object(value: unknown): Record<string, unknown> {
  need(
    typeof value === "object" &&
      value !== null &&
      !types.isProxy(value) &&
      !Array.isArray(value),
  );
  const prototype = Object.getPrototypeOf(value);
  need(prototype === Object.prototype || prototype === null);
  return value as Record<string, unknown>;
}
function property(value: unknown, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), name);
  if (!descriptor) return undefined;
  need(Object.hasOwn(descriptor, "value"));
  return descriptor.value;
}
function keys(value: unknown, maximum: number): string[] {
  const receiver = object(value),
    names = Reflect.ownKeys(receiver);
  need(names.length <= maximum);
  return names.map((name) => {
    need(typeof name === "string");
    const descriptor = Object.getOwnPropertyDescriptor(receiver, name)!;
    need(
      descriptor.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        !types.isProxy(descriptor.value),
    );
    return name;
  });
}
function array(value: unknown): unknown[] {
  need(!types.isProxy(value) && Array.isArray(value));
  return value;
}
function item(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  need(
    descriptor &&
      Object.hasOwn(descriptor, "value") &&
      !types.isProxy(descriptor.value),
  );
  return descriptor.value;
}
function canonicalRoot(value: unknown): asserts value is string {
  need(
    typeof value === "string" &&
      value.length > 1 &&
      value.length <= 4096 &&
      !/[\\\0-\x1f:]/.test(value) &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      path.normalize(value) === value,
  );
}
function directoryChain(directory: string): void {
  const parsed = path.parse(directory),
    parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  need(parts.length <= CHAIN_SUMMARY_WORKSPACE_LIMITS.pathSegments);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    need(stat.isDirectory() && !stat.isSymbolicLink());
  }
  need(fs.realpathSync(directory) === directory);
}
function readFixed(file: string, maximum: number): Uint8Array {
  directoryChain(path.dirname(file));
  const before = fs.lstatSync(file);
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0 &&
      before.size <= maximum,
  );
  need(fs.realpathSync(file) === file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(fd);
    need(
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size,
    );
    const data = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < data.length) {
      const read = fs.readSync(fd, data, count, data.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    need(
      count === before.size &&
        after.size === before.size &&
        after.dev === before.dev &&
        after.ino === before.ino,
    );
    const current = fs.lstatSync(file);
    need(
      current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        fs.realpathSync(file) === file,
    );
    return data.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

/** Call only after the original proof has failed. Never loads the input code. */
export function probeChainSummaryWorkspaceIdentity(
  sourceRoot: unknown,
  dependencyRoot: unknown,
  metafile: unknown,
): ChainSummaryWorkspaceReport {
  const result = empty();
  let inputs: unknown, expectedKey: string, baseRoot: string;
  try {
    canonicalRoot(sourceRoot);
    canonicalRoot(dependencyRoot);
    need(path.basename(dependencyRoot) === "node_modules");
    baseRoot = path.dirname(dependencyRoot);
    need(
      sourceRoot === baseRoot ||
        (!sourceRoot.startsWith(baseRoot + path.sep) &&
          !baseRoot.startsWith(sourceRoot + path.sep)),
    );
    const expected = path.join(baseRoot, DIST);
    expectedKey = path.relative(sourceRoot, expected);
    inputs = property(metafile, "inputs");
    const names = keys(inputs, CHAIN_SUMMARY_WORKSPACE_LIMITS.inputs);
    const logicalIdentities = new Set<string>();
    let characters = 0,
      importCount = 0,
      targetCharacters = 0;
    for (const name of names) {
      need(
        name.length > 0 &&
          name.length <= CHAIN_SUMMARY_WORKSPACE_LIMITS.keyCharacters,
      );
      characters += name.length;
      need(characters <= CHAIN_SUMMARY_WORKSPACE_LIMITS.keyCharactersTotal);
      const record = property(inputs, name);
      keys(record, CHAIN_SUMMARY_WORKSPACE_LIMITS.fields);
      const imports = array(property(record, "imports"));
      need(
        imports.length <= CHAIN_SUMMARY_WORKSPACE_LIMITS.imports - importCount,
      );
      for (let index = 0; index < imports.length; index++) {
        const row = item(imports, index);
        keys(row, CHAIN_SUMMARY_WORKSPACE_LIMITS.fields);
        const target = property(row, "path"),
          kind = property(row, "kind"),
          external = property(row, "external"),
          original = property(row, "original");
        need(
          typeof target === "string" &&
            target.length > 0 &&
            target.length <= CHAIN_SUMMARY_WORKSPACE_LIMITS.targetCharacters,
        );
        need(typeof kind === "string" && kind.length > 0 && kind.length <= 64);
        need(external === undefined || external === false || external === true);
        need(
          original === undefined ||
            (typeof original === "string" && original.length <= 4096),
        );
        targetCharacters += target.length;
        need(
          targetCharacters <=
            CHAIN_SUMMARY_WORKSPACE_LIMITS.targetCharactersTotal,
        );
        importCount++;
      }
      if (name.startsWith("native-node-require:")) {
        need(
          /^native-node-require:[A-Za-z0-9_/-]+$/.test(name) &&
            isBuiltin(name.slice("native-node-require:".length)),
        );
      } else {
        need(!path.isAbsolute(name) && !/[\\\0-\x1f:]/.test(name));
        const resolved = path.resolve(sourceRoot, name);
        need(path.relative(sourceRoot, resolved) === name);
        if (
          !resolved.startsWith(sourceRoot + path.sep) &&
          !resolved.startsWith(dependencyRoot + path.sep)
        ) {
          result.escapedCount++;
          if (name === expectedKey) result.exactMatches++;
          else result.otherEscapedCount++;
        } else {
          const logical = ownerSourceIdentity(sourceRoot, dependencyRoot, name);
          need(!logicalIdentities.has(logical));
          logicalIdentities.add(logical);
        }
      }
      result.inputCount++;
    }
    result.inputScanComplete = true;
  } catch {
    return empty();
  }
  if (result.exactMatches === 0) {
    result.status = "no-match";
    return result;
  }
  if (
    result.exactMatches !== 1 ||
    result.escapedCount !== 1 ||
    result.otherEscapedCount !== 0
  ) {
    result.status = "key-refused";
    return result;
  }
  result.status = "edge-refused";
  try {
    const dist = property(inputs, expectedKey!);
    need(
      property(dist, "bytes") === rawPins[DIST].bytes &&
        array(property(dist, "imports")).length === 0,
    );
    for (const edge of EDGES) {
      const source = property(inputs, edge.source);
      need(property(source, "bytes") === rawPins[edge.source].bytes);
      const row = item(array(property(source, "imports")), edge.index);
      need(
        property(row, "path") === expectedKey! &&
          property(row, "kind") === "import-statement" &&
          (property(row, "external") === undefined ||
            property(row, "external") === false) &&
          property(row, "original") === PACKAGE,
      );
      result.matchedEdges++;
    }
  } catch {
    return result;
  }
  result.status = "link-refused";
  try {
    directoryChain(sourceRoot as string);
    directoryChain(dependencyRoot as string);
    const candidateModules = path.join(sourceRoot as string, "node_modules");
    need(
      fs.lstatSync(candidateModules).isSymbolicLink() &&
        fs.readlinkSync(candidateModules) === dependencyRoot &&
        fs.realpathSync(candidateModules) === dependencyRoot,
    );
    directoryChain(path.join(dependencyRoot as string, "@jsonbored"));
    const link = path.join(dependencyRoot as string, PACKAGE),
      target = path.join(baseRoot!, "packages/chain-summaries");
    need(
      fs.lstatSync(link).isSymbolicLink() &&
        fs.readlinkSync(link) === "../../packages/chain-summaries" &&
        fs.realpathSync(link) === target,
    );
    directoryChain(target);
    directoryChain(path.join(sourceRoot as string, "packages/chain-summaries"));
    let totalBytes = 0;
    for (const [name, pin] of Object.entries(rawPins)) {
      for (const root of name.startsWith("src/")
        ? [sourceRoot as string]
        : [sourceRoot as string, baseRoot!]) {
        result.status = "read-refused";
        const bytes = readFixed(
          path.join(root, name),
          Math.min(
            pin.bytes,
            CHAIN_SUMMARY_WORKSPACE_LIMITS.fileBytes,
            CHAIN_SUMMARY_WORKSPACE_LIMITS.allFileBytes - totalBytes,
          ),
        );
        totalBytes += bytes.length;
        need(totalBytes <= CHAIN_SUMMARY_WORKSPACE_LIMITS.allFileBytes);
        result.status = "pin-refused";
        need(
          bytes.length === pin.bytes &&
            createHash("sha256").update(bytes).digest("hex") === pin.sha256 &&
            createHash("sha1")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex") === pin.gitBlob,
        );
      }
    }
    result.status = "identified";
    return result;
  } catch {
    return result;
  }
}

function checkedReport(value: unknown): ChainSummaryWorkspaceReport | null {
  try {
    const names = keys(value, 9);
    need(
      names.length === 9 &&
        names.every((name) =>
          [
            "version",
            "identity",
            "status",
            "inputScanComplete",
            "inputCount",
            "escapedCount",
            "exactMatches",
            "otherEscapedCount",
            "matchedEdges",
          ].includes(name),
        ),
    );
    need(
      property(value, "version") === 1 &&
        property(value, "identity") === "chain-summaries-dist",
    );
    const status = property(value, "status"),
      complete = property(value, "inputScanComplete");
    need(
      typeof status === "string" &&
        (CHAIN_SUMMARY_WORKSPACE_STATUSES as readonly string[]).includes(
          status,
        ) &&
        typeof complete === "boolean",
    );
    const counts = [
      "inputCount",
      "escapedCount",
      "exactMatches",
      "otherEscapedCount",
      "matchedEdges",
    ].map((name) => property(value, name));
    need(
      counts.every(
        (count) =>
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          count <= CHAIN_SUMMARY_WORKSPACE_LIMITS.inputs,
      ),
    );
    const [
      inputCount,
      escapedCount,
      exactMatches,
      otherEscapedCount,
      matchedEdges,
    ] = counts as number[];
    need(
      exactMatches! <= 1 &&
        matchedEdges! <= 2 &&
        matchedEdges! <= Math.max(0, inputCount! - 1) &&
        escapedCount! <= inputCount! &&
        exactMatches! + otherEscapedCount! === escapedCount!,
    );
    if (!complete)
      need(status === "scan-refused" && counts.every((count) => count === 0));
    else {
      need(status !== "scan-refused");
      if (status === "no-match") need(exactMatches === 0 && matchedEdges === 0);
      else if (status === "key-refused")
        need(
          exactMatches === 1 && otherEscapedCount! > 0 && matchedEdges === 0,
        );
      else {
        need(
          exactMatches === 1 && otherEscapedCount === 0 && escapedCount === 1,
        );
        if (status === "edge-refused") need(matchedEdges! < 2);
        else need(matchedEdges === 2);
      }
    }
    return {
      version: 1,
      identity: "chain-summaries-dist",
      status: status as Status,
      inputScanComplete: complete,
      inputCount: inputCount!,
      escapedCount: escapedCount!,
      exactMatches: exactMatches!,
      otherEscapedCount: otherEscapedCount!,
      matchedEdges: matchedEdges!,
    };
  } catch {
    return null;
  }
}
export function chainSummaryWorkspaceMarker(report: unknown): string {
  const value = checkedReport(report);
  if (!value) return "";
  return `[owner-workspace-input:1:${value.status}:${value.inputScanComplete ? 1 : 0}:${value.inputCount}:${value.escapedCount}:${value.exactMatches}:${value.otherEscapedCount}:${value.matchedEdges}]`;
}
export function parseChainSummaryWorkspaceMarker(
  text: unknown,
): ChainSummaryWorkspaceReport | null {
  if (
    typeof text !== "string" ||
    text.length > CHAIN_SUMMARY_WORKSPACE_LIMITS.markerCharacters
  )
    return null;
  const broad = "[owner-workspace-input",
    prefix = broad + ":";
  const start = text.indexOf(broad);
  if (
    start < 0 ||
    text.indexOf(broad, start + broad.length) !== -1 ||
    !text.startsWith(prefix, start)
  )
    return null;
  const end = text.indexOf("]", start + prefix.length);
  if (end < 0 || end - start > 160) return null;
  const fields = text.slice(start + prefix.length, end).split(":");
  if (
    fields.length !== 8 ||
    fields[0] !== "1" ||
    !/^[01]$/.test(fields[2]!) ||
    !fields.slice(3).every((field) => /^(?:0|[1-9][0-9]{0,3})$/.test(field))
  )
    return null;
  const [
    inputCount,
    escapedCount,
    exactMatches,
    otherEscapedCount,
    matchedEdges,
  ] = fields.slice(3).map(Number);
  return checkedReport({
    version: 1,
    identity: "chain-summaries-dist",
    status: fields[1],
    inputScanComplete: fields[2] === "1",
    inputCount,
    escapedCount,
    exactMatches,
    otherEscapedCount,
    matchedEdges,
  });
}
