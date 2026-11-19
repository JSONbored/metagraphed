import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  identifyInputOnlyPublicImports as identify,
  selectInputOnlyPublicSourcePaths as select,
  revalidateInputOnlyPublicDiagnostics as revalidate,
  PUBLIC_INPUT_ONLY_KINDS,
  PUBLIC_INPUT_ONLY_LIMITS,
  PUBLIC_INPUT_ONLY_REFUSALS,
  type InputOnlyPublicEvidence,
} from "./input-only-public-diagnostics.ts";

const digest = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
interface Fixture extends Omit<InputOnlyPublicEvidence, "metafile"> {
  metafile: {
    inputs: Record<
      string,
      {
        bytes: number;
        imports: { path: string; kind: string; external?: boolean }[];
      }
    >;
    outputs: Record<
      string,
      {
        bytes: number;
        imports: { path: string; kind: string; external?: boolean }[];
      }
    >;
  };
  sourceBytes: Record<string, Uint8Array>;
}
function fixture(
  source = "import type { Value } from 'example-package';\nexport const value = 1;\n",
  target = "example-package",
  sourcePath = "src/public.ts",
): Fixture {
  const bytes = new TextEncoder().encode(source);
  return {
    sourceRoot: "/review/candidate",
    dependencyRoot: "/review/dependencies/node_modules",
    metafile: {
      inputs: {
        [sourcePath]: {
          bytes: bytes.byteLength,
          imports: [{ path: target, kind: "import-statement", external: true }],
        },
      },
      outputs: {
        "../output/index.mjs": {
          bytes: 1,
          imports: [] as { path: string; kind: string; external?: boolean }[],
        },
      },
    },
    publicSources: Object.freeze([
      Object.freeze({ path: sourcePath, gitBlob: digest(bytes) }),
    ]),
    sourceBytes: { [sourcePath]: bytes },
  };
}
function input(value: Fixture) {
  return value.metafile.inputs[Object.keys(value.metafile.inputs)[0]]!;
}
function emitted(value: Fixture) {
  return value.metafile.outputs["../output/index.mjs"]!.imports;
}
function roundTrip(value: Fixture) {
  const result = identify(value);
  assert.deepEqual(
    revalidate(JSON.parse(JSON.stringify(result)), value.publicSources),
    result,
  );
  return result;
}
function refused(
  value: Fixture,
  reason: (typeof PUBLIC_INPUT_ONLY_REFUSALS)[number],
) {
  const result = roundTrip(value);
  assert.equal(result.complete, false);
  assert.equal(result.identifiedCount, 0);
  assert.equal(result.refused[reason], 1);
  return result;
}
test("identifies only a hash-verified public source and exact quoted-text position", () => {
  const value = fixture();
  const result = roundTrip(value);
  assert.equal(result.complete, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.identifiedCount, 1);
  assert.deepEqual(result.records, [
    {
      sourcePath: "src/public.ts",
      gitBlob: value.publicSources[0].gitBlob,
      importIndex: 0,
      kind: "import-statement",
      literalLocations: [{ line: 1, column: 28 }],
    },
  ]);
  assert.deepEqual(select(value), ["src/public.ts"]);
  assert.ok(!JSON.stringify(result).includes("example-package"));
});
for (const kind of PUBLIC_INPUT_ONLY_KINDS)
  test(`fixed kind ${kind} can be identified as text only`, () => {
    const value = fixture();
    input(value).imports[0].kind = kind;
    assert.equal(roundTrip(value).records[0].kind, kind);
  });
test("complete scan retains later unknown after recognized optional package", () => {
  const value = fixture(
    "import 'bufferutil';\nimport 'later-secret-token';",
    "bufferutil",
  );
  input(value).imports.push({
    path: "later-secret-token",
    kind: "import-statement",
    external: true,
  });
  const result = roundTrip(value);
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(
    result.records.map((row) => row.importIndex),
    [0, 1],
  );
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});
test("pg-native and approved builtin prefixes are not candidates", () => {
  const value = fixture();
  input(value).imports = ["pg-native", "node:fs", "cloudflare:workers"].map(
    (path) => ({ path, kind: "require-call", external: true }),
  );
  assert.equal(roundTrip(value).candidateCount, 0);
  assert.deepEqual(select(value), []);
});
test("nonexternal inputs are excluded", () => {
  const value = fixture();
  input(value).imports[0].external = false;
  assert.equal(roundTrip(value).candidateCount, 0);
});
for (const external of [true, false, undefined])
  test(`target equality in any output refuses (external=${external})`, () => {
    const value = fixture();
    emitted(value).push({
      path: "example-package",
      kind: "import-statement",
      external,
    });
    refused(value, "emittedTarget");
    assert.deepEqual(select(value), []);
  });
test("output match is exact original path equality", () => {
  const value = fixture();
  emitted(value).push({
    path: "example-package-extra",
    kind: "import-statement",
    external: true,
  });
  assert.equal(roundTrip(value).identifiedCount, 1);
});
test("later output entry is scanned", () => {
  const value = fixture();
  value.metafile.outputs["../output/later.mjs"] = {
    bytes: 1,
    imports: [
      { path: "example-package", kind: "import-statement", external: true },
    ],
  };
  refused(value, "emittedTarget");
});
for (const key of [
  "../dependencies/node_modules/private/index.js",
  "native-node-require:fs",
  "../other/src/public.ts",
  "/review/candidate/src/public.ts",
  "src/./public.ts",
  "src//public.ts",
])
  test(`unsafe/unindexed importer is not identified: ${key}`, () => {
    const value = fixture();
    const entry = input(value);
    value.metafile.inputs = { [key]: entry };
    refused(value, "unindexed");
    assert.deepEqual(select(value), []);
  });
for (const alias of [
  "./src/public.ts",
  "src/../src/public.ts",
  "/review/candidate/src/public.ts",
  "src//public.ts",
])
  test(`invalid alias poisons canonical identity: ${alias}`, () => {
    const value = fixture();
    value.metafile.inputs[alias] = { bytes: 0, imports: [] };
    refused(value, "ambiguousSource");
    assert.deepEqual(select(value), []);
  });
test("missing source bytes", () => {
  const value = fixture();
  value.sourceBytes = {};
  refused(value, "missingSource");
});
test("altered source bytes", () => {
  const value = fixture();
  value.sourceBytes["src/public.ts"][0] ^= 1;
  refused(value, "sourceMismatch");
});
test("metadata byte count mismatch", () => {
  const value = fixture();
  input(value).bytes++;
  refused(value, "sourceMismatch");
});
test("invalid UTF-8 with matching Git blob is refused", () => {
  const value = fixture();
  const bytes = new Uint8Array([0xff]);
  value.sourceBytes["src/public.ts"] = bytes;
  input(value).bytes = 1;
  value.publicSources = Object.freeze([
    Object.freeze({ path: "src/public.ts", gitBlob: digest(bytes) }),
  ]);
  refused(value, "sourceMismatch");
});
test("unsupported kind", () => {
  const value = fixture();
  input(value).imports[0].kind = "secret-kind";
  refused(value, "unsupportedKind");
});
test("no exact quoted target", () => {
  const value = fixture("const x=1;", "secret-target");
  refused(value, "noLiteral");
});
test("three exact occurrences sorted with CRLF and Unicode line separators", () => {
  const value = fixture(
    "'example-package';\r\n  \"example-package\";\u2028'example-package';",
  );
  assert.deepEqual(roundTrip(value).records[0].literalLocations, [
    { line: 1, column: 1 },
    { line: 2, column: 3 },
    { line: 3, column: 1 },
  ]);
});
test("four occurrences are ambiguous for this bounded diagnostic", () => {
  refused(fixture("'example-package';".repeat(4)), "tooManyLiterals");
});
test("columns count UTF-16 code units and retain BOM", () => {
  assert.deepEqual(
    roundTrip(fixture("\ufeff😀 'example-package';")).records[0]
      .literalLocations,
    [{ line: 1, column: 5 }],
  );
});
test("escaped quotes do not match", () => {
  refused(fixture("\\'example-package\\'"), "noLiteral");
});
for (const target of ["a\\b", "a\nb", "a\u2028b"])
  test("unsafe target escaping is refused without reflection", () => {
    refused(fixture(`'${target}'`, target), "noLiteral");
  });
test("out-of-range line", () => {
  refused(fixture("\n".repeat(99999) + "'example-package'"), "malformed");
});
test("out-of-range column", () => {
  refused(fixture(" ".repeat(9999) + "'example-package'"), "malformed");
});
test("maximum allowed source location", () => {
  const value = fixture(
    "\n".repeat(99998) + " ".repeat(9998) + "'example-package'",
  );
  assert.deepEqual(roundTrip(value).records[0].literalLocations, [
    { line: 99999, column: 9999 },
  ]);
});
test("literal-looking comment is reported only as a quoted-text occurrence", () => {
  const result = roundTrip(fixture("// 'example-package'\nconst value=1;"));
  assert.deepEqual(result.records[0].literalLocations, [
    { line: 1, column: 4 },
  ]);
});
test("secret-looking target remains absent from all public output", () => {
  const target = "https://secret.invalid/?token=do-not-print";
  const result = roundTrip(fixture(`import '${target}';`, target));
  assert.equal(result.identifiedCount, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("https"));
});
for (const sourcePath of [
  "apps/ui/$route.ts",
  "apps/ui/docs[.]txt.ts",
  "packages/@scope/.hidden.ts",
])
  test(`verified public filename grammar: ${sourcePath}`, () => {
    assert.equal(
      roundTrip(fixture(undefined, undefined, sourcePath)).identifiedCount,
      1,
    );
  });
for (const sourcePath of [
  "../private.ts",
  "/private.ts",
  "a//b.ts",
  "a/./b.ts",
  "a/../b.ts",
  "node_modules/x.ts",
  "a/node_modules/x.ts",
  ".git/config",
  "a\\b.ts",
  "https:secret",
  "a".repeat(513),
])
  test("invalid frozen public index fails closed", () => {
    const value = fixture(undefined, undefined, sourcePath);
    const result = identify(value);
    assert.equal(result.identifiedCount, 0);
    assert.equal(result.refused.malformed, 1);
    assert.deepEqual(select(value), []);
    assert.equal(revalidate(result, value.publicSources), null);
  });
test("mutable index and mutable rows fail closed", () => {
  for (const publicSources of [
    [...fixture().publicSources],
    Object.freeze([{ ...fixture().publicSources[0] }]),
  ]) {
    const value = { ...fixture(), publicSources };
    assert.equal(identify(value).refused.malformed, 1);
    assert.deepEqual(select(value), []);
  }
});
test("duplicate pinned paths fail closed", () => {
  const value = fixture();
  value.publicSources = Object.freeze([
    value.publicSources[0],
    value.publicSources[0],
  ]);
  assert.equal(identify(value).refused.malformed, 1);
  assert.deepEqual(select(value), []);
});
test("unindexed supplied bytes fail closed", () => {
  const value = fixture();
  value.sourceBytes["private.ts"] = new Uint8Array();
  refused(value, "malformed");
});
test("oversized source refuses without decoding", () => {
  const value = fixture();
  value.sourceBytes["src/public.ts"] = new Uint8Array(
    PUBLIC_INPUT_ONLY_LIMITS.sourceBytes + 1,
  );
  refused(value, "malformed");
});
test("shared source buffers are refused", () => {
  const value = fixture();
  value.sourceBytes["src/public.ts"] = new Uint8Array(new SharedArrayBuffer(8));
  refused(value, "malformed");
});
test("typed array shadow getters never execute", () => {
  const value = fixture();
  let calls = 0;
  for (const name of ["byteLength", "buffer", "byteOffset", "length"])
    Object.defineProperty(value.sourceBytes["src/public.ts"], name, {
      get() {
        calls++;
        throw Error("SECRET");
      },
    });
  assert.equal(roundTrip(value).identifiedCount, 1);
  assert.equal(calls, 0);
});
test("65 candidates preserve bounded counters and source selection refuses overflow", () => {
  const value = fixture();
  input(value).imports = Array.from({ length: 65 }, () => ({
    ...input(value).imports[0],
  }));
  const result = roundTrip(value);
  assert.equal(result.identifiedCount, 64);
  assert.equal(result.overflowCount, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(select(value), []);
});
test("import scope budget covers all records, not just candidates", () => {
  const value = fixture();
  input(value).imports = Array.from({ length: 65537 }, () => ({
    path: "node:fs",
    kind: "import-statement",
    external: true,
  }));
  const result = roundTrip(value);
  assert.equal(result.inputScanComplete, false);
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(select(value), []);
});
test("per-scope total target character budget is enforced", () => {
  const value = fixture();
  input(value).imports = Array.from({ length: 4097 }, () => ({
    path: "x".repeat(4096),
    kind: "import-statement",
    external: true,
  }));
  assert.equal(roundTrip(value).inputScanComplete, false);
});
test("input record budget", () => {
  const value = fixture();
  value.metafile.inputs = Object.fromEntries(
    Array.from({ length: 8193 }, (_, n) => [
      `src/${n}.ts`,
      { bytes: 0, imports: [] },
    ]),
  );
  assert.equal(roundTrip(value).inputScanComplete, false);
});
test("output record budget", () => {
  const value = fixture();
  value.metafile.outputs = Object.fromEntries(
    Array.from({ length: 1025 }, (_, n) => [
      `out/${n}.mjs`,
      { bytes: 0, imports: [] },
    ]),
  );
  const result = roundTrip(value);
  assert.equal(result.outputScanComplete, false);
  assert.equal(result.refused.malformed, 1);
});
for (const field of ["path", "kind", "external"])
  test(`malformed ${field} causes incomplete scan`, () => {
    const value = fixture();
    (input(value).imports[0] as Record<string, unknown>)[field] = {
      toString() {
        throw Error("SECRET");
      },
    };
    const result = roundTrip(value);
    assert.equal(result.inputScanComplete, false);
    assert.equal(result.candidateCount, 0);
  });
test("oversized target causes incomplete scan", () => {
  const value = fixture();
  input(value).imports[0].path = "x".repeat(4097);
  assert.equal(roundTrip(value).inputScanComplete, false);
});
test("malformed later output never permits partial identity", () => {
  const value = fixture();
  emitted(value).push({
    path: "node:fs",
    kind: "import-statement",
    external: true,
  });
  emitted(value).push({
    path: "x",
    kind: "import-statement",
    external: "bad" as unknown as boolean,
  });
  const result = roundTrip(value);
  assert.equal(result.outputScanComplete, false);
  assert.equal(result.records.length, 0);
  assert.equal(result.refused.malformed, 1);
});
const proxyTargets = [
  "evidence",
  "metafile",
  "inputs",
  "input",
  "imports",
  "import",
  "outputs",
  "output",
  "outputImports",
  "outputImport",
  "index",
  "pin",
  "sources",
  "bytes",
] as const;
for (const target of proxyTargets)
  test(`proxy ${target} executes zero traps`, () => {
    const value: any = fixture();
    let calls = 0;
    const proxy = <T extends object>(object: T): T =>
      new Proxy(object, {
        get() {
          calls++;
          throw Error("SECRET");
        },
        ownKeys() {
          calls++;
          throw Error("SECRET");
        },
        getOwnPropertyDescriptor() {
          calls++;
          throw Error("SECRET");
        },
        getPrototypeOf() {
          calls++;
          throw Error("SECRET");
        },
        isExtensible() {
          calls++;
          throw Error("SECRET");
        },
      });
    let evidence = value;
    switch (target) {
      case "evidence":
        evidence = proxy(value);
        break;
      case "metafile":
        value.metafile = proxy(value.metafile);
        break;
      case "inputs":
        value.metafile.inputs = proxy(value.metafile.inputs);
        break;
      case "input":
        value.metafile.inputs["src/public.ts"] = proxy(input(value));
        break;
      case "imports":
        input(value).imports = proxy(input(value).imports);
        break;
      case "import":
        input(value).imports[0] = proxy(input(value).imports[0]);
        break;
      case "outputs":
        value.metafile.outputs = proxy(value.metafile.outputs);
        break;
      case "output":
        value.metafile.outputs["../output/index.mjs"] = proxy(
          value.metafile.outputs["../output/index.mjs"],
        );
        break;
      case "outputImports":
        value.metafile.outputs["../output/index.mjs"].imports = proxy([]);
        break;
      case "outputImport":
        emitted(value).push(
          proxy({ path: "x", kind: "import-statement", external: true }) as any,
        );
        break;
      case "index":
        value.publicSources = proxy(value.publicSources);
        break;
      case "pin":
        value.publicSources = Object.freeze([proxy(value.publicSources[0])]);
        break;
      case "sources":
        value.sourceBytes = proxy(value.sourceBytes);
        break;
      case "bytes":
        value.sourceBytes["src/public.ts"] = proxy(
          value.sourceBytes["src/public.ts"],
        );
        break;
    }
    assert.equal(identify(evidence).identifiedCount, 0);
    select(evidence);
    assert.equal(calls, 0);
  });
for (const target of [
  "evidence",
  "inputs",
  "input",
  "import",
  "array",
  "sources",
])
  test(`accessor ${target} executes zero getters`, () => {
    const value: any = fixture();
    let calls = 0;
    const get = () => {
      calls++;
      throw Error("SECRET");
    };
    if (target === "evidence")
      Object.defineProperty(value, "metafile", { get });
    if (target === "inputs")
      Object.defineProperty(value.metafile.inputs, "src/public.ts", { get });
    if (target === "input")
      Object.defineProperty(input(value), "imports", { get });
    if (target === "import")
      Object.defineProperty(input(value).imports[0], "path", { get });
    if (target === "array")
      Object.defineProperty(input(value).imports, "0", { get });
    if (target === "sources")
      Object.defineProperty(value.sourceBytes, "src/public.ts", { get });
    assert.equal(identify(value).identifiedCount, 0);
    select(value);
    assert.equal(calls, 0);
  });
test("revalidator reconstructs fixed schema without preserving extra identity", () => {
  const value = fixture();
  const original = identify(value);
  const result = revalidate(original, value.publicSources)!;
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
  assert.notEqual(result.records, original.records);
});
const malformedPublicResults: [string, (value: any) => void][] = [
  ["unknown root key", (v) => (v.secret = "SECRET")],
  ["unknown refusal key", (v) => (v.refused.secret = 1)],
  ["unknown record key", (v) => (v.records[0].target = "SECRET")],
  [
    "unknown location key",
    (v) => (v.records[0].literalLocations[0].secret = 1),
  ],
  ["count overflow", (v) => (v.candidateCount = 65537)],
  ["NaN", (v) => (v.refusedCount = NaN)],
  ["fraction", (v) => (v.candidateCount = 1.1)],
  ["negative", (v) => (v.overflowCount = -1)],
  ["missing count", (v) => delete v.refusedCount],
  ["count mismatch", (v) => (v.candidateCount = 2)],
  ["refusal sum mismatch", (v) => (v.refused.malformed = 1)],
  ["contradictory scan", (v) => (v.inputScanComplete = false)],
  ["contradictory complete", (v) => (v.complete = false)],
  ["unknown path", (v) => (v.records[0].sourcePath = "private/secret.ts")],
  ["wrong blob", (v) => (v.records[0].gitBlob = "0".repeat(40))],
  ["unknown kind", (v) => (v.records[0].kind = "SECRET")],
  ["index overflow", (v) => (v.records[0].importIndex = 65536)],
  ["index fraction", (v) => (v.records[0].importIndex = 0.5)],
  [
    "duplicate identity",
    (v) => {
      v.records.push(v.records[0]);
      v.identifiedCount = 2;
      v.candidateCount = 2;
    },
  ],
  ["missing locations", (v) => (v.records[0].literalLocations = [])],
  ["zero line", (v) => (v.records[0].literalLocations[0].line = 0)],
  ["line overflow", (v) => (v.records[0].literalLocations[0].line = 100000)],
  ["column overflow", (v) => (v.records[0].literalLocations[0].column = 10000)],
  [
    "duplicate locations",
    (v) => v.records[0].literalLocations.push(v.records[0].literalLocations[0]),
  ],
  [
    "unsorted locations",
    (v) => v.records[0].literalLocations.push({ line: 1, column: 1 }),
  ],
  ["unknown array key", (v) => (v.records.secret = "SECRET")],
];
for (const [name, mutate] of malformedPublicResults)
  test(`public revalidator rejects ${name}`, () => {
    const value = fixture();
    const result: any = identify(value);
    mutate(result);
    assert.equal(revalidate(result, value.publicSources), null);
  });
for (const target of [
  "root",
  "records",
  "record",
  "locations",
  "location",
  "refused",
])
  test(`public revalidator proxy ${target} runs no traps`, () => {
    const value = fixture();
    let result: any = identify(value);
    let calls = 0;
    const proxy = (v: any) =>
      new Proxy(v, {
        get() {
          calls++;
          throw Error("SECRET");
        },
        ownKeys() {
          calls++;
          throw Error("SECRET");
        },
        getOwnPropertyDescriptor() {
          calls++;
          throw Error("SECRET");
        },
        getPrototypeOf() {
          calls++;
          throw Error("SECRET");
        },
      });
    if (target === "root") result = proxy(result);
    if (target === "records") result.records = proxy(result.records);
    if (target === "record") result.records[0] = proxy(result.records[0]);
    if (target === "locations")
      result.records[0].literalLocations = proxy(
        result.records[0].literalLocations,
      );
    if (target === "location")
      result.records[0].literalLocations[0] = proxy(
        result.records[0].literalLocations[0],
      );
    if (target === "refused") result.refused = proxy(result.refused);
    assert.equal(revalidate(result, value.publicSources), null);
    assert.equal(calls, 0);
  });
test("public revalidator accessor runs no getter", () => {
  const value = fixture();
  const result = identify(value);
  let calls = 0;
  Object.defineProperty(result, "records", {
    get() {
      calls++;
      throw Error("SECRET");
    },
  });
  assert.equal(revalidate(result, value.publicSources), null);
  assert.equal(calls, 0);
});
test("fixed public enums and limits are frozen", () => {
  assert.ok(Object.isFrozen(PUBLIC_INPUT_ONLY_KINDS));
  assert.ok(Object.isFrozen(PUBLIC_INPUT_ONLY_REFUSALS));
  assert.ok(Object.isFrozen(PUBLIC_INPUT_ONLY_LIMITS));
});
test("total supplied source bytes are bounded across the full inventory", () => {
  const value = fixture();
  const bytes = new Uint8Array(PUBLIC_INPUT_ONLY_LIMITS.sourceBytes);
  const gitBlob = digest(bytes);
  const paths = Array.from({ length: 17 }, (_, n) => `src/large${n}.ts`);
  value.publicSources = Object.freeze([
    ...value.publicSources,
    ...paths.map((path) => Object.freeze({ path, gitBlob })),
  ]);
  for (const path of paths) value.sourceBytes[path] = bytes;
  refused(value, "malformed");
});
test("largest record inventory stays below the fixed serialized budget", () => {
  const sourcePath = "src/" + "a".repeat(505) + ".ts";
  assert.equal(sourcePath.length, 512);
  const value = fixture(
    "\n".repeat(99998) +
      " ".repeat(9900) +
      "'example-package';'example-package';'example-package'",
    undefined,
    sourcePath,
  );
  input(value).imports = Array.from({ length: 64 }, () => ({
    path: "example-package",
    kind: "import-statement",
    external: true,
  }));
  const result = roundTrip(value);
  assert.equal(result.identifiedCount, 64);
  assert.equal(result.complete, true);
  assert.ok(
    JSON.stringify(result).length <
      PUBLIC_INPUT_ONLY_LIMITS.serializedCharacters,
  );
});
for (const scope of ["inputs", "outputs"] as const)
  test(`non-enumerable ${scope} row makes the scan incomplete`, () => {
    const value = fixture();
    Object.defineProperty(value.metafile[scope], "hidden", {
      value: { bytes: 1, imports: [] },
      enumerable: false,
    });
    const result = roundTrip(value);
    assert.equal(
      scope === "inputs" ? result.inputScanComplete : result.outputScanComplete,
      false,
    );
  });
test("symbol metadata keys cannot hide from a complete scan", () => {
  const value = fixture();
  Object.defineProperty(value.metafile.outputs, Symbol("secret"), {
    value: { bytes: 1, imports: [] },
  });
  assert.equal(roundTrip(value).outputScanComplete, false);
});
test("sparse import arrays are incomplete", () => {
  const value = fixture();
  input(value).imports.length = 2;
  assert.equal(roundTrip(value).inputScanComplete, false);
});
test("unrelated refusal and overflow counters partition all candidates", () => {
  const value = fixture();
  input(value).imports = Array.from({ length: 66 }, (_, n) => ({
    path: n === 0 ? "example-package" : "no-literal",
    kind: "import-statement",
    external: true,
  }));
  const result = roundTrip(value);
  assert.equal(result.candidateCount, 66);
  assert.equal(result.identifiedCount, 1);
  assert.equal(result.refused.noLiteral, 63);
  assert.equal(result.overflowCount, 2);
});
test("public revalidator rejects fabricated overflow distribution", () => {
  const value = fixture();
  const result = identify(value);
  result.overflowCount = 1;
  result.candidateCount = 2;
  result.complete = false;
  assert.equal(revalidate(result, value.publicSources), null);
});
test("an inherited result field does not satisfy the public schema", () => {
  const value = fixture();
  const result = identify(value);
  const fake = Object.create({ version: 1 });
  Object.assign(fake, result);
  delete fake.version;
  assert.equal(revalidate(fake, value.publicSources), null);
});
