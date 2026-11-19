// Exact raw-owner workspace custody. This pending identity never admits a graph.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { types } from "node:util";
import {
  ownerProofFailure,
  withOwnerProofReason,
} from "./owner-proof-reasons.ts";
import type { OwnerProofReasonCode } from "./owner-proof-reason-codes.ts";
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
export const CHAIN_SUMMARY_WORKSPACE_DIST =
  "packages/chain-summaries/dist/index.js";
const PACKAGE = "@jsonbored/chain-summaries";
export const CHAIN_SUMMARY_WORKSPACE_EDGES = Object.freeze([
  Object.freeze({ source: "src/extrinsics.ts", index: 8 }),
  Object.freeze({ source: "src/chain-detail-hot-tier.ts", index: 10 }),
] as const);

const DIST = CHAIN_SUMMARY_WORKSPACE_DIST;
const EDGES = CHAIN_SUMMARY_WORKSPACE_EDGES;
export const WORKSPACE_CUSTODY_LIMITS = Object.freeze({
  inputs: 8192,
  outputs: 1024,
  imports: 65536,
  fields: 16,
  characters: 16 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  totalBytes: 2 * 1024 * 1024,
  segments: 64,
});
export interface ChainSummaryWorkspaceCustody {
  readonly kind: "pending-chain-summary-workspace-custody";
}
export interface ChainSummaryWorkspaceSource {
  readonly logical: typeof DIST;
  readonly actual: string;
  readonly canonicalFile: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Roots {
  root: string;
  dependency: string;
  base: string;
  canonical: string;
  actual: string;
  aliases: ReadonlySet<string>;
}
interface Snapshot {
  roots: Roots;
  metafile: object;
  fingerprint: string;
}
const custody = new WeakMap<object, Snapshot>();
function check(
  code: OwnerProofReasonCode,
  value: unknown,
  description: string,
): asserts value {
  if (!value) throw ownerProofFailure(new Error(description), code);
}
function object(value: unknown): Record<string, unknown> {
  check(
    "wsc-001",
    typeof value === "object" &&
      value !== null &&
      !types.isProxy(value) &&
      !Array.isArray(value),
    "Workspace metadata must be a nonproxy object",
  );
  const proto = Object.getPrototypeOf(value);
  check(
    "wsc-002",
    proto === Object.prototype || proto === null,
    "Workspace metadata must be plain data",
  );
  return value as Record<string, unknown>;
}
function keys(value: unknown, maximum: number): string[] {
  const record = object(value),
    names = Reflect.ownKeys(record);
  check(
    "wsc-003",
    names.length <= maximum,
    "Workspace metadata field budget exceeded",
  );
  return names.map((name) => {
    check(
      "wsc-004",
      typeof name === "string",
      "Workspace metadata symbol key refused",
    );
    const d = Object.getOwnPropertyDescriptor(record, name)!;
    check(
      "wsc-005",
      d.enumerable && Object.hasOwn(d, "value") && !types.isProxy(d.value),
      "Workspace metadata accessor or proxy refused",
    );
    return name;
  });
}
function prop(value: unknown, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object(value), name);
  if (!d) return undefined;
  check(
    "wsc-006",
    Object.hasOwn(d, "value") && !types.isProxy(d.value),
    "Workspace property accessor or proxy refused",
  );
  return d.value;
}
function list(value: unknown): unknown[] {
  check(
    "wsc-007",
    !types.isProxy(value) && Array.isArray(value),
    "Workspace imports must be a nonproxy array",
  );
  check(
    "wsc-008",
    value.length <= WORKSPACE_CUSTODY_LIMITS.imports,
    "Workspace import array budget exceeded",
  );
  check(
    "wsc-056",
    Object.getPrototypeOf(value) === Array.prototype,
    "Workspace import array prototype refused",
  );
  const names = Reflect.ownKeys(value);
  check(
    "wsc-057",
    names.length === value.length + 1 &&
      names.every(
        (name) =>
          typeof name === "string" &&
          (name === "length" ||
            (/^(?:0|[1-9][0-9]*)$/.test(name) && Number(name) < value.length)),
      ),
    "Workspace import array must have only dense length and index keys",
  );
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    check(
      "wsc-058",
      Object.hasOwn(descriptor, "value") &&
        !types.isProxy(descriptor.value) &&
        (name === "length" || descriptor.enumerable),
      "Workspace import array accessor refused",
    );
  }
  return value;
}
function item(value: unknown[], index: number): unknown {
  const d = Object.getOwnPropertyDescriptor(value, String(index));
  check(
    "wsc-009",
    d && Object.hasOwn(d, "value") && !types.isProxy(d.value),
    "Workspace import item must be own plain data",
  );
  return d.value;
}
function root(value: unknown): asserts value is string {
  check(
    "wsc-010",
    typeof value === "string" &&
      value.length > 1 &&
      value.length <= 4096 &&
      !/[\\\0-\x1f:]/.test(value) &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      path.normalize(value) === value,
    "Workspace root must be exact canonical spelling",
  );
}
function roots(sourceRoot: unknown, dependencyRoot: unknown): Roots {
  root(sourceRoot);
  root(dependencyRoot);
  const base = path.dirname(dependencyRoot),
    canonical = path.join(base, DIST);
  return {
    root: sourceRoot,
    dependency: dependencyRoot,
    base,
    canonical,
    actual: path.relative(sourceRoot, canonical),
    aliases: new Set([
      path.join(sourceRoot, DIST),
      path.join(sourceRoot, "node_modules", PACKAGE, "dist/index.js"),
      path.join(dependencyRoot, PACKAGE, "dist/index.js"),
    ]),
  };
}
function inputNames(metafile: unknown): string[] {
  const names = keys(prop(metafile, "inputs"), WORKSPACE_CUSTODY_LIMITS.inputs);
  let characters = 0;
  for (const name of names) {
    check(
      "wsc-054",
      name.length > 0 && name.length <= 4096,
      "Workspace input key length budget exceeded",
    );
    characters += name.length;
    check(
      "wsc-055",
      characters <= WORKSPACE_CUSTODY_LIMITS.characters,
      "Workspace input key text budget exceeded",
    );
  }
  return names;
}
function pending(r: Roots, metafile: unknown): boolean {
  const names = inputNames(metafile);
  return (
    path.basename(r.dependency) === "node_modules" &&
    !r.canonical.startsWith(r.root + path.sep) &&
    !r.canonical.startsWith(r.dependency + path.sep) &&
    names.includes(r.actual)
  );
}
export function hasChainSummaryWorkspaceInput(
  sourceRoot: unknown,
  dependencyRoot: unknown,
  metafile: unknown,
): boolean {
  return pending(roots(sourceRoot, dependencyRoot), metafile);
}
function scan(r: Roots, metafile: unknown): string {
  check(
    "wsc-011",
    path.basename(r.dependency) === "node_modules",
    "Workspace dependency root must be node_modules",
  );
  check(
    "wsc-012",
    r.root !== r.base &&
      !r.root.startsWith(r.base + path.sep) &&
      !r.base.startsWith(r.root + path.sep),
    "Workspace proof requires disjoint source and base roots",
  );

  const names = inputNames(metafile),
    inputs = prop(metafile, "inputs");
  check(
    "wsc-013",
    pending(r, metafile),
    "Exact escaped workspace input is required",
  );
  let characters = 0,
    importsCount = 0,
    incoming = 0,
    contributionCount = 0;
  const inputSet = new Set(names);
  const fingerprint: unknown[] = [];
  for (const name of names) {
    check(
      "wsc-014",
      name.length > 0 && name.length <= 4096 && !/[\\\0-\x1f]/.test(name),
      "Workspace input key shape refused",
    );
    characters += name.length;
    check(
      "wsc-052",
      characters <= WORKSPACE_CUSTODY_LIMITS.characters,
      "Workspace input text budget exceeded before scanning record",
    );
    if (name.startsWith("native-node-require:")) {
      check(
        "wsc-050",
        /^native-node-require:[A-Za-z0-9_/-]+$/.test(name) &&
          isBuiltin(name.slice("native-node-require:".length)),
        "Invalid workspace graph builtin identity",
      );
    } else {
      const absolute = path.resolve(r.root, name);
      check(
        "wsc-015",
        !path.isAbsolute(name) &&
          !name.includes(":") &&
          path.relative(r.root, absolute) === name,
        "Workspace input key spelling refused",
      );
      check(
        "wsc-016",
        name === r.actual || !r.aliases.has(absolute),
        "Duplicate workspace input alias refused",
      );
      check(
        "wsc-051",
        name === r.actual ||
          absolute.startsWith(r.root + path.sep) ||
          absolute.startsWith(r.dependency + path.sep),
        "Another escaped workspace input refused",
      );
    }
    const record = prop(inputs, name);
    keys(record, WORKSPACE_CUSTODY_LIMITS.fields);
    const bytes = prop(record, "bytes");
    check(
      "wsc-017",
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
      "Workspace input byte count malformed",
    );
    const rows = list(prop(record, "imports"));
    importsCount += rows.length;
    check(
      "wsc-018",
      importsCount <= WORKSPACE_CUSTODY_LIMITS.imports,
      "Workspace whole input import budget exceeded",
    );
    const imported: unknown[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = item(rows, index);
      keys(row, WORKSPACE_CUSTODY_LIMITS.fields);
      const target = prop(row, "path"),
        kind = prop(row, "kind"),
        external = prop(row, "external"),
        original = prop(row, "original");
      check(
        "wsc-019",
        typeof target === "string" &&
          target.length > 0 &&
          target.length <= 4096 &&
          typeof kind === "string" &&
          kind.length > 0 &&
          kind.length <= 64 &&
          (external === undefined || typeof external === "boolean") &&
          (original === undefined ||
            (typeof original === "string" && original.length <= 4096)),
        "Workspace import record shape refused",
      );
      characters +=
        target.length +
        kind.length +
        (typeof original === "string" ? original.length : 0);
      check(
        "wsc-020",
        characters <= WORKSPACE_CUSTODY_LIMITS.characters,
        "Workspace whole graph text budget exceeded",
      );
      if (target === r.actual) {
        const edge = EDGES.find(
          (edge) => edge.source === name && edge.index === index,
        );
        check(
          "wsc-021",
          edge &&
            kind === "import-statement" &&
            original === PACKAGE &&
            external !== true,
          "Unexpected incoming workspace edge",
        );
        incoming++;
      } else if (!target.includes(":")) {
        check(
          "wsc-022",
          path.resolve(r.root, target) !== r.canonical &&
            !r.aliases.has(path.resolve(r.root, target)),
          "Workspace edge alias refused",
        );
      }
      imported.push([target, kind, external ?? null, original ?? null]);
    }
    fingerprint.push([name, bytes, imported]);
  }
  check(
    "wsc-023",
    characters <= WORKSPACE_CUSTODY_LIMITS.characters && incoming === 2,
    "Exactly two original workspace edges required",
  );
  const dist = prop(inputs, r.actual);
  check(
    "wsc-024",
    prop(dist, "bytes") === rawPins[DIST].bytes &&
      list(prop(dist, "imports")).length === 0,
    "Workspace dist input identity changed",
  );
  for (const edge of EDGES) {
    const source = prop(inputs, edge.source);
    check(
      "wsc-025",
      prop(source, "bytes") === rawPins[edge.source].bytes,
      "Workspace importer input byte count changed",
    );
  }
  const outputs = prop(metafile, "outputs"),
    outputNames = keys(outputs, WORKSPACE_CUSTODY_LIMITS.outputs);
  for (const name of outputNames) {
    check(
      "wsc-026",
      name.length > 0 && name.length <= 4096 && !/[\\\0-\x1f:]/.test(name),
      "Workspace output key shape refused",
    );
    characters += name.length;
    check(
      "wsc-053",
      characters <= WORKSPACE_CUSTODY_LIMITS.characters,
      "Workspace output key text budget exceeded",
    );
    const record = prop(outputs, name);
    keys(record, WORKSPACE_CUSTODY_LIMITS.fields);
    const outputImports = list(prop(record, "imports"));
    importsCount += outputImports.length;
    check(
      "wsc-059",
      importsCount <= WORKSPACE_CUSTODY_LIMITS.imports,
      "Workspace complete graph import budget exceeded",
    );
    const outputImportSnapshot: unknown[] = [];
    for (let index = 0; index < outputImports.length; index++) {
      const row = item(outputImports, index);
      keys(row, WORKSPACE_CUSTODY_LIMITS.fields);
      const target = prop(row, "path"),
        kind = prop(row, "kind"),
        external = prop(row, "external"),
        original = prop(row, "original");
      check(
        "wsc-060",
        typeof target === "string" &&
          target.length > 0 &&
          target.length <= 4096 &&
          typeof kind === "string" &&
          kind.length > 0 &&
          kind.length <= 64 &&
          (external === undefined || typeof external === "boolean") &&
          (original === undefined ||
            (typeof original === "string" && original.length <= 4096)),
        "Workspace output import record shape refused",
      );
      characters +=
        target.length +
        kind.length +
        (typeof original === "string" ? original.length : 0);
      check(
        "wsc-061",
        characters <= WORKSPACE_CUSTODY_LIMITS.characters,
        "Workspace output import text budget exceeded",
      );
      check(
        "wsc-062",
        target.includes(":") ||
          (path.resolve(r.root, target) !== r.canonical &&
            !r.aliases.has(path.resolve(r.root, target))),
        "Workspace source cannot be an emitted import target",
      );
      outputImportSnapshot.push([
        target,
        kind,
        external ?? null,
        original ?? null,
      ]);
    }
    const contributions = prop(record, "inputs"),
      contributionNames = keys(contributions, WORKSPACE_CUSTODY_LIMITS.inputs);
    contributionCount += contributionNames.length;
    check(
      "wsc-049",
      contributionCount <= WORKSPACE_CUSTODY_LIMITS.imports,
      "Workspace whole contribution record budget exceeded",
    );
    const entries: unknown[] = [];
    for (const actual of contributionNames) {
      check(
        "wsc-027",
        actual.length > 0 && actual.length <= 4096 && inputSet.has(actual),
        "Workspace output contribution has no exact input",
      );
      const contribution = prop(contributions, actual);
      keys(contribution, WORKSPACE_CUSTODY_LIMITS.fields);
      const bytes = prop(contribution, "bytesInOutput");
      check(
        "wsc-028",
        typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
        "Workspace contribution count malformed",
      );
      check(
        "wsc-029",
        actual !== r.actual || name.endsWith(".js"),
        "Workspace contribution in non-JS output refused",
      );
      characters += actual.length;
      check(
        "wsc-030",
        characters <= WORKSPACE_CUSTODY_LIMITS.characters,
        "Workspace whole contribution text budget exceeded",
      );
      entries.push([actual, bytes]);
    }
    fingerprint.push([name, outputImportSnapshot, entries]);
  }
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}
function directory(directory: string): void {
  const parsed = path.parse(directory),
    parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  check(
    "wsc-031",
    parts.length <= WORKSPACE_CUSTODY_LIMITS.segments,
    "Workspace directory depth exceeded",
  );
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = withOwnerProofReason("wsc-op-directory-stat", () =>
      fs.lstatSync(current),
    );
    check(
      "wsc-032",
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Workspace ancestor must be a regular directory",
    );
  }
  check(
    "wsc-033",
    withOwnerProofReason("wsc-op-directory-realpath", () =>
      fs.realpathSync(directory),
    ) === directory,
    "Workspace directory realpath changed",
  );
}
function read(file: string, maximum: number): Uint8Array {
  directory(path.dirname(file));
  const before = withOwnerProofReason("wsc-op-file-stat", () =>
    fs.lstatSync(file),
  );
  check(
    "wsc-034",
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0 &&
      before.size <= maximum,
    "Workspace fixed file size or kind refused",
  );
  check(
    "wsc-035",
    withOwnerProofReason("wsc-op-file-realpath", () =>
      fs.realpathSync(file),
    ) === file,
    "Workspace fixed file realpath changed",
  );
  const fd = withOwnerProofReason("wsc-op-file-open", () =>
    fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    ),
  );
  try {
    const opened = withOwnerProofReason("wsc-op-file-fstat", () =>
      fs.fstatSync(fd),
    );
    check(
      "wsc-036",
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size,
      "Workspace opened file identity changed",
    );
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = withOwnerProofReason("wsc-op-file-read", () =>
        fs.readSync(fd, bytes, count, bytes.length - count, null),
      );
      if (n === 0) break;
      count += n;
    }
    const after = withOwnerProofReason("wsc-op-file-fstat", () =>
      fs.fstatSync(fd),
    );
    check(
      "wsc-037",
      count === before.size &&
        after.size === before.size &&
        after.dev === before.dev &&
        after.ino === before.ino,
      "Workspace fixed file changed during read",
    );
    const current = withOwnerProofReason("wsc-op-file-stat", () =>
      fs.lstatSync(file),
    );
    check(
      "wsc-038",
      current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        current.size === before.size &&
        withOwnerProofReason("wsc-op-file-realpath", () =>
          fs.realpathSync(file),
        ) === file,
      "Workspace file identity changed after read",
    );
    return bytes.subarray(0, count);
  } finally {
    withOwnerProofReason("wsc-op-file-close", () => fs.closeSync(fd));
  }
}
function physical(r: Roots): void {
  directory(r.root);
  directory(r.dependency);
  const candidateModules = path.join(r.root, "node_modules"),
    link = path.join(r.dependency, PACKAGE),
    target = path.join(r.base, "packages/chain-summaries");
  check(
    "wsc-039",
    withOwnerProofReason(
      "wsc-op-candidate-link",
      () =>
        fs.lstatSync(candidateModules).isSymbolicLink() &&
        fs.readlinkSync(candidateModules) === r.dependency &&
        fs.realpathSync(candidateModules) === r.dependency,
    ),
    "Candidate dependency link changed",
  );
  directory(path.join(r.dependency, "@jsonbored"));
  check(
    "wsc-040",
    withOwnerProofReason(
      "wsc-op-workspace-link",
      () =>
        fs.lstatSync(link).isSymbolicLink() &&
        fs.readlinkSync(link) === "../../packages/chain-summaries" &&
        fs.realpathSync(link) === target,
    ),
    "Exact workspace package link changed",
  );
  directory(target);
  directory(path.join(r.root, "packages/chain-summaries"));
  let total = 0;
  for (const [name, pin] of Object.entries(rawPins)) {
    for (const base of name.startsWith("src/") ? [r.root] : [r.root, r.base]) {
      const bytes = read(
        path.join(base, name),
        Math.min(
          pin.bytes,
          WORKSPACE_CUSTODY_LIMITS.fileBytes,
          WORKSPACE_CUSTODY_LIMITS.totalBytes - total,
        ),
      );
      total += bytes.length;
      check(
        "wsc-041",
        total <= WORKSPACE_CUSTODY_LIMITS.totalBytes,
        "Workspace aggregate file budget exceeded",
      );
      check(
        "wsc-042",
        bytes.length === pin.bytes,
        "Workspace pinned byte count changed",
      );
      check(
        "wsc-043",
        createHash("sha256").update(bytes).digest("hex") === pin.sha256,
        "Workspace pinned SHA-256 changed",
      );
      check(
        "wsc-044",
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") === pin.gitBlob,
        "Workspace pinned Git blob changed",
      );
    }
  }
}
export function readChainSummaryWorkspaceCustody(
  sourceRoot: unknown,
  dependencyRoot: unknown,
  metafile: unknown,
): ChainSummaryWorkspaceCustody | null {
  const r = roots(sourceRoot, dependencyRoot);
  if (!pending(r, metafile)) return null;
  const fingerprint = scan(r, metafile);
  physical(r);
  check(
    "wsc-045",
    scan(r, metafile) === fingerprint,
    "Workspace metadata changed during physical proof",
  );
  const token = Object.freeze({
    kind: "pending-chain-summary-workspace-custody" as const,
  });
  custody.set(token, { roots: r, metafile: object(metafile), fingerprint });
  return token;
}
function authenticated(
  token: unknown,
  sourceRoot: string,
  dependencyRoot: string,
  metafile: unknown,
): Snapshot {
  check(
    "wsc-046",
    typeof token === "object" && token !== null && !types.isProxy(token),
    "Workspace custody object missing or untrusted",
  );
  const value = custody.get(token);
  check(
    "wsc-047",
    value &&
      value.roots.root === sourceRoot &&
      value.roots.dependency === dependencyRoot &&
      value.metafile === metafile,
    "Workspace custody is forged or bound to another graph",
  );
  check(
    "wsc-048",
    scan(value.roots, metafile) === value.fingerprint,
    "Workspace graph changed after custody was minted",
  );
  return value;
}
export function chainSummaryWorkspaceInputIdentity(
  token: unknown,
  sourceRoot: string,
  dependencyRoot: string,
  metafile: unknown,
  actualKey: string,
): typeof DIST | null {
  if (token === undefined || token === null) return null;
  // Only the single exact route incurs the bounded whole-graph recheck.
  const r = roots(sourceRoot, dependencyRoot);
  if (actualKey !== r.actual) return null;
  authenticated(token, sourceRoot, dependencyRoot, metafile);
  return DIST;
}
export function chainSummaryWorkspaceSource(
  token: unknown,
  sourceRoot: string,
  dependencyRoot: string,
  metafile: unknown,
): Readonly<ChainSummaryWorkspaceSource> {
  const value = authenticated(token, sourceRoot, dependencyRoot, metafile);
  return Object.freeze({
    logical: DIST,
    actual: value.roots.actual,
    canonicalFile: value.roots.canonical,
    bytes: rawPins[DIST].bytes,
    sha256: rawPins[DIST].sha256,
  });
}
