import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DISCARDED_INPUT_SOURCE_PINS,
  DISCARDED_INPUT_RECORD_PINS,
  ERASURE_CONFIG_SOURCE_PINS,
  DISCARDED_INPUT_LIMITS,
  planDiscardedInputReads,
  type ErasureConfigSources,
} from "./discarded-input-proof.ts";
import {
  OPTIONAL_PG_SOURCE_PINS,
  ownerSourceIdentity,
  collectOptionalPgExternalImportCounts,
  optionalProofDiagnosticMarkers,
  OPTIONAL_PROOF_STAGES,
  OPTIONAL_IMPORT_CATEGORIES,
  OPTIONAL_PG_DIAGNOSTIC_LIMITS,
  optionalPgExternalRefusalMarker,
  assertOptionalPgExternalImport,
  validateOptionalPgNativeImport,
  type OptionalPgEvidence,
} from "./optional-pg-import.ts";
const fixtures = JSON.parse(
  readFileSync(
    new URL("./optional-pg-source-fixtures.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;
function decodeInertFixture(
  value: any,
  pins: Record<string, { bytes: number; sha256: string; gitBlob: string }>,
): Record<string, string> {
  assert.deepEqual(
    Object.keys(value).sort(),
    ["version", "encoding", "decodedBytes", "decodedSha256", "contents"].sort(),
  );
  assert.equal(value.version, 1);
  assert.equal(value.encoding, "gzip-base64");
  assert.ok(
    typeof value.contents === "string" &&
      value.contents.length < 512 * 1024 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(value.contents),
  );
  assert.ok(
    Number.isSafeInteger(value.decodedBytes) &&
      value.decodedBytes > 0 &&
      value.decodedBytes <= 2 * 1024 * 1024,
  );
  assert.match(value.decodedSha256, /^[a-f0-9]{64}$/);
  const bytes = gunzipSync(Buffer.from(value.contents, "base64"), {
    maxOutputLength: 2 * 1024 * 1024,
  });
  assert.equal(bytes.length, value.decodedBytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    value.decodedSha256,
  );
  const data = JSON.parse(bytes.toString("utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(data).sort(), Object.keys(pins).sort());
  for (const [name, pin] of Object.entries(pins)) {
    assert.equal(typeof data[name], "string");
    const source = Buffer.from(data[name]!);
    assert.equal(source.length, pin.bytes);
    assert.equal(createHash("sha256").update(source).digest("hex"), pin.sha256);
    assert.equal(
      createHash("sha1")
        .update(`blob ${source.length}\0`)
        .update(source)
        .digest("hex"),
      pin.gitBlob,
    );
  }
  return data;
}
const sourceFixtureEnvelope = JSON.parse(
  readFileSync(
    new URL("./discarded-input-source-fixtures.json", import.meta.url),
    "utf8",
  ),
);
const configFixtureEnvelope = JSON.parse(
  readFileSync(
    new URL("./erasure-config-source-fixtures.json", import.meta.url),
    "utf8",
  ),
);
const discardedFixtures = decodeInertFixture(
  sourceFixtureEnvelope,
  DISCARDED_INPUT_SOURCE_PINS,
);
const configFixtures = decodeInertFixture(
  configFixtureEnvelope,
  ERASURE_CONFIG_SOURCE_PINS,
);
const names = Object.keys(OPTIONAL_PG_SOURCE_PINS);
const [ESM, MAIN, NATIVE, CLIENT] = names as [string, string, string, string];
const outputKey =
  "../../tmp/raw-owner-qualification-Ab12/modules/chunks/pg-test.js";
const mapKey = outputKey + ".map";

test("diagnostic stage and category vocabularies are frozen", () => {
  assert.ok(Object.isFrozen(OPTIONAL_PROOF_STAGES));
  assert.ok(Object.isFrozen(OPTIONAL_IMPORT_CATEGORIES));
  assert.ok(Object.isFrozen(OPTIONAL_PG_DIAGNOSTIC_LIMITS));
  assert.equal(
    new Set(OPTIONAL_PROOF_STAGES).size,
    OPTIONAL_PROOF_STAGES.length,
  );
  assert.deepEqual(OPTIONAL_IMPORT_CATEGORIES, [
    "pg-native",
    "bufferutil",
    "utf-8-validate",
    "node",
    "cloudflare",
    "other",
  ]);
});
const diagnosticImport = (path: unknown, external: unknown = true) => ({
  path,
  external,
  kind: "require-call",
});
const zeroCounts = {
  "pg-native": 0,
  bufferutil: 0,
  "utf-8-validate": 0,
  node: 0,
  cloudflare: 0,
  other: 0,
};
test("complete diagnostics scan all categories even after the first refused import", () => {
  const e = sample();
  e.metafile.inputs[CLIENT]!.imports.push(
    ...[
      "bufferutil",
      "utf-8-validate",
      "node:fs",
      "cloudflare:workers",
      "private-token/secret",
      "private-later/secret",
    ].map((value) => diagnosticImport(value) as any),
  );
  e.metafile.outputs[outputKey]!.imports.push(
    ...[
      "bufferutil",
      "utf-8-validate",
      "node:crypto",
      "cloudflare:sockets",
      "private-output-secret",
    ].map((value) => diagnosticImport(value) as any),
  );
  const counts = collectOptionalPgExternalImportCounts(e.metafile);
  assert.deepEqual(counts.input, {
    complete: true,
    counts: {
      "pg-native": 1,
      bufferutil: 1,
      "utf-8-validate": 1,
      node: 1,
      cloudflare: 1,
      other: 2,
    },
  });
  assert.deepEqual(counts.output, {
    complete: true,
    counts: {
      "pg-native": 1,
      bufferutil: 1,
      "utf-8-validate": 1,
      node: 1,
      cloudflare: 1,
      other: 1,
    },
  });
  assert.throws(
    () => validateOptionalPgNativeImport(e),
    (error) => {
      assert.ok(error instanceof Error);
      const marker = optionalProofDiagnosticMarkers(error);
      assert.ok(
        marker.includes("[owner-optional-proof-failed:external-imports]"),
      );
      assert.ok(
        marker.includes("[owner-optional-import-counts:input:1:1:1:1:1:1:2]"),
      );
      assert.ok(
        marker.includes("[owner-optional-import-counts:output:1:1:1:1:1:1:1]"),
      );
      assert.ok(!marker.includes("secret"));
      assert.ok(marker.length < 512);
      return true;
    },
  );
});
test("unknown huge and marker-looking target strings only contribute to other", () => {
  const counts = collectOptionalPgExternalImportCounts({
    inputs: {
      private: {
        imports: [
          diagnosticImport("secret/" + "x".repeat(1_000_000)),
          diagnosticImport("[owner-optional-proof-failed:roots]\nsecret"),
          diagnosticImport("node:private"),
        ],
      },
    },
    outputs: {},
  });
  assert.deepEqual(counts.input, {
    complete: true,
    counts: { ...zeroCounts, node: 1, other: 2 },
  });
  assert.deepEqual(counts.output, { complete: true, counts: zeroCounts });
});
const malformedDiagnostics: [string, unknown][] = [
  ["non-object table", { inputs: [], outputs: {} }],
  ["missing import array", { inputs: { x: {} }, outputs: {} }],
  ["non-array imports", { inputs: { x: { imports: {} } }, outputs: {} }],
  [
    "null target",
    {
      inputs: {
        x: { imports: [diagnosticImport("pg-native"), diagnosticImport(null)] },
      },
      outputs: {},
    },
  ],
  [
    "object target",
    {
      inputs: {
        x: {
          imports: [
            diagnosticImport("pg-native"),
            diagnosticImport({
              toString() {
                throw new Error("private");
              },
            }),
          ],
        },
      },
      outputs: {},
    },
  ],
  [
    "invalid external flag",
    {
      inputs: {
        x: {
          imports: [
            diagnosticImport("pg-native"),
            diagnosticImport("secret", "true"),
          ],
        },
      },
      outputs: {},
    },
  ],
  ["sparse imports", { inputs: { x: { imports: new Array(2) } }, outputs: {} }],
  [
    "null import",
    {
      inputs: { x: { imports: [diagnosticImport("pg-native"), null] } },
      outputs: {},
    },
  ],
];
for (const [label, meta] of malformedDiagnostics) {
  test("diagnostics incomplete and zeroed: " + label, () => {
    assert.deepEqual(collectOptionalPgExternalImportCounts(meta), {
      input: { complete: false, counts: zeroCounts },
      output: { complete: true, counts: zeroCounts },
    });
  });
}
test("diagnostics do not run accessors and zero counts from a partial scan", () => {
  let called = 0;
  const second = {
    get path() {
      called++;
      throw new Error("private");
    },
    external: true,
  };
  const counts = collectOptionalPgExternalImportCounts({
    inputs: { x: { imports: [diagnosticImport("pg-native"), second] } },
    outputs: {},
  });
  assert.equal(called, 0);
  assert.deepEqual(counts.input, { complete: false, counts: zeroCounts });
});
test("diagnostics reject proxies at every reflection boundary without running traps", () => {
  let traps = 0;
  const proxy = (target: object) =>
    new Proxy(target, {
      get() {
        traps++;
        throw new Error("private-get-trap");
      },
      ownKeys() {
        traps++;
        throw new Error("private-own-keys-trap");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("private-descriptor-trap");
      },
      getPrototypeOf() {
        traps++;
        throw new Error("private-prototype-trap");
      },
    });
  const inputs = [
    proxy({}),
    { x: proxy({ imports: [] }) },
    { x: { imports: proxy([]) } },
    {
      x: {
        imports: [
          diagnosticImport("pg-native"),
          proxy({ path: "secret", external: true }),
        ],
      },
    },
  ];
  for (const input of inputs) {
    assert.deepEqual(
      collectOptionalPgExternalImportCounts({ inputs: input, outputs: {} }),
      {
        input: { complete: false, counts: zeroCounts },
        output: { complete: true, counts: zeroCounts },
      },
    );
  }
  assert.deepEqual(
    collectOptionalPgExternalImportCounts(proxy({ inputs: {}, outputs: {} })),
    {
      input: { complete: false, counts: zeroCounts },
      output: { complete: false, counts: zeroCounts },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(collectOptionalPgExternalImportCounts(revoked.proxy), {
    input: { complete: false, counts: zeroCounts },
    output: { complete: false, counts: zeroCounts },
  });
  assert.equal(traps, 0);
});
test("failure wrapper never reads or reflects on a thrown proxy cause", () => {
  let traps = 0;
  const cause = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("private");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("private");
      },
      ownKeys() {
        traps++;
        throw new Error("private");
      },
    },
  );
  const e = sample();
  Object.defineProperty(e, "sourceRoot", {
    get() {
      throw cause;
    },
  });
  assert.throws(
    () => validateOptionalPgNativeImport(e),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, cause);
      assert.equal(optionalProofDiagnosticMarkers(error).split("\n").length, 3);
      assert.equal(traps, 0);
      return true;
    },
  );
});
test("per-scope cumulative import limit includes nonexternal imports", () => {
  const batch = Array.from({ length: 32768 }, () =>
    diagnosticImport("internal", false),
  );
  const counts = collectOptionalPgExternalImportCounts({
    inputs: {
      a: { imports: batch },
      b: { imports: batch },
      c: { imports: [diagnosticImport("pg-native")] },
    },
    outputs: { one: { imports: [diagnosticImport("utf-8-validate")] } },
  });
  assert.deepEqual(counts.input, { complete: false, counts: zeroCounts });
  assert.deepEqual(counts.output, {
    complete: true,
    counts: { ...zeroCounts, "utf-8-validate": 1 },
  });
});
test("exact import limit remains complete with a bounded category sum", () => {
  const counts = collectOptionalPgExternalImportCounts({
    inputs: {
      x: {
        imports: Array.from({ length: 65536 }, () =>
          diagnosticImport("other-secret"),
        ),
      },
    },
    outputs: {},
  });
  assert.equal(counts.input.complete, true);
  assert.equal(counts.input.counts.other, 65536);
  assert.equal(
    Object.values(counts.input.counts).reduce((a, b) => a + b, 0),
    65536,
  );
});
test("record budgets and oversized import arrays mark only that scope incomplete", () => {
  const inputRecords = Object.fromEntries(
    Array.from({ length: 8193 }, (_, index) => [
      String(index),
      { imports: [] },
    ]),
  );
  const outputRecords = Object.fromEntries(
    Array.from({ length: 1025 }, (_, index) => [
      String(index),
      { imports: [] },
    ]),
  );
  assert.deepEqual(
    collectOptionalPgExternalImportCounts({ inputs: inputRecords, outputs: {} })
      .input,
    { complete: false, counts: zeroCounts },
  );
  assert.deepEqual(
    collectOptionalPgExternalImportCounts({
      inputs: {},
      outputs: outputRecords,
    }).output,
    { complete: false, counts: zeroCounts },
  );
  assert.deepEqual(
    collectOptionalPgExternalImportCounts({
      inputs: { x: { imports: new Array(65537) } },
      outputs: {},
    }).input,
    { complete: false, counts: zeroCounts },
  );
});
test("diagnostic failure never replaces the original proof cause", () => {
  const e = sample();
  const original = new Error("private-original-error");
  Object.defineProperty(e, "sourceRoot", {
    get() {
      throw original;
    },
  });
  Object.defineProperty(e, "metafile", {
    get() {
      throw new Error("diagnostics-must-not-run-this");
    },
  });
  assert.throws(
    () => validateOptionalPgNativeImport(e),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, original);
      assert.equal(
        error.message,
        "[owner-optional-proof-failed:roots]\n[owner-optional-import-counts:input:0:0:0:0:0:0:0]\n[owner-optional-import-counts:output:0:0:0:0:0:0:0]",
      );
      return true;
    },
  );
});
test("trusted formatter accepts only exact validator-branded error identity", () => {
  let branded: unknown;
  const e = sample();
  e.sourceRoot = "relative";
  try {
    validateOptionalPgNativeImport(e);
  } catch (error) {
    branded = error;
  }
  const marker = optionalProofDiagnosticMarkers(branded);
  assert.ok(marker.startsWith("[owner-optional-proof-failed:roots]"));
  let touched = 0;
  const poison = new Proxy(
    {},
    {
      get() {
        touched++;
        throw new Error("private");
      },
      getOwnPropertyDescriptor() {
        touched++;
        throw new Error("private");
      },
    },
  );
  for (const other of [
    new Error(marker),
    { message: marker },
    poison,
    null,
    undefined,
    "secret",
    12,
    Symbol("secret"),
    () => undefined,
  ])
    assert.equal(optionalProofDiagnosticMarkers(other), "");
  assert.equal(touched, 0);
  assert.ok(branded instanceof Error);
  branded.message = "private-mutation";
  assert.equal(optionalProofDiagnosticMarkers(branded), marker);
});

const fixedMarker =
  /^\[owner-optional-import-refused:(input|output|unknown):(bufferutil|utf-8-validate|other)\]$/;
for (const scope of ["input", "output", "unknown"] as const) {
  for (const label of ["bufferutil", "utf-8-validate", "other"] as const) {
    test(`fixed external diagnostic classifies ${scope}/${label}`, () => {
      const target = label === "other" ? "/private/unknown-package" : label;
      const expected = `[owner-optional-import-refused:${scope}:${label}]`;
      assert.equal(optionalPgExternalRefusalMarker(scope, target), expected);
      assert.throws(
        () => assertOptionalPgExternalImport(scope, target),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, expected);
          assert.equal(Object.hasOwn(error, "actual"), false);
          assert.equal(Object.hasOwn(error, "cause"), false);
          return true;
        },
      );
    });
  }
}
test("fixed classifier never copies, normalizes or stringifies unknown targets", () => {
  const poison = {
    toString() {
      throw new Error("must not stringify");
    },
    [Symbol.toPrimitive]() {
      throw new Error("must not coerce");
    },
  };
  const targets: unknown[] = [
    undefined,
    null,
    true,
    42,
    Symbol("private-symbol"),
    poison,
    "pg-native",
    "Bufferutil",
    " bufferutil",
    "bufferutil/extra",
    "utf-8-validate\nprivate",
    "\u0000secret",
    "private/" + "x".repeat(1_000_000),
  ];
  for (const target of targets) {
    assert.equal(
      optionalPgExternalRefusalMarker("input", target),
      "[owner-optional-import-refused:input:other]",
    );
    assert.throws(() => assertOptionalPgExternalImport("input", target), {
      message: "[owner-optional-import-refused:input:other]",
    });
  }
});
test("unknown or oversized scopes always reduce to one fixed scope label", () => {
  for (const scope of [
    undefined,
    null,
    1,
    {},
    Symbol("secret"),
    "INPUT",
    "input:private",
    "x".repeat(1_000_000),
  ]) {
    const marker = optionalPgExternalRefusalMarker(scope, "bufferutil");
    assert.equal(marker, "[owner-optional-import-refused:unknown:bufferutil]");
    assert.match(marker, fixedMarker);
  }
});
test("diagnostic replacement preserves the exact existing builtin acceptance predicate", () => {
  const values = [
    "node:fs",
    "node:",
    "cloudflare:workers",
    "cloudflare:",
    "node:" + "x".repeat(1_000_000),
    "cloudflare:\nprivate",
    "xnode:fs",
    "Node:fs",
    "node",
    "cloudflare",
    "pg-native",
    "bufferutil",
    "utf-8-validate",
    "",
    "/private/path",
  ];
  for (const target of values) {
    const expected = /^(?:node:|cloudflare:)/.test(target);
    for (const scope of ["input", "output", "unknown"]) {
      if (expected)
        assert.doesNotThrow(() =>
          assertOptionalPgExternalImport(scope, target),
        );
      else
        assert.throws(
          () => assertOptionalPgExternalImport(scope, target),
          (error) => error instanceof Error && fixedMarker.test(error.message),
        );
    }
  }
});
for (const scope of ["input", "output"] as const) {
  for (const target of [
    "bufferutil",
    "utf-8-validate",
    "/private/unrecognized-import",
  ]) {
    test(`validator emits bounded ${scope} metadata refusal for ${target === "/private/unrecognized-import" ? "other" : target}`, () => {
      const e = sample();
      const info =
        scope === "input"
          ? e.metafile.inputs[MAIN]!
          : e.metafile.outputs[outputKey]!;
      info.imports.push({ path: target, kind: "require-call", external: true });
      assert.throws(
        () => validateOptionalPgNativeImport(e),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.split("\n").length, 3);
          assert.equal(
            error.message.split("\n")[0],
            "[owner-optional-proof-failed:external-imports]",
          );
          assert.ok(error.cause instanceof Error);
          assert.equal(
            error.cause.message,
            optionalPgExternalRefusalMarker(scope, target),
          );
          assert.equal(optionalProofDiagnosticMarkers(error), error.message);
          return true;
        },
      );
    });
  }
}
const vlq = (number: number) => {
  let value = number < 0 ? -number * 2 + 1 : number * 2;
  let encoded = "";
  do {
    let digit = value % 32;
    value = Math.floor(value / 32);
    if (value) digit |= 32;
    encoded +=
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[digit];
  } while (value);
  return encoded;
};
function sample(): OptionalPgEvidence {
  const sourceRoot = "/review/repo";
  const outputRoot = "/tmp/raw-owner-qualification-Ab12/modules";
  const output = Buffer.from(
    'let a=1;\nlet b=2;\nlet c=3;\nlet d=q("pg-native");\n',
  );
  const sourceMap = Buffer.from(
    JSON.stringify({
      version: 3,
      sources: names.map((name) =>
        path.relative(
          path.dirname(path.resolve(sourceRoot, outputKey)),
          path.resolve(sourceRoot, name),
        ),
      ),
      sourcesContent: names.map((name) => fixtures[name]),
      names: [],
      mappings: [
        [0, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [6, 1, 6, 11],
      ]
        .map((fields) => fields.map(vlq).join(""))
        .join(";"),
    }),
  );
  return {
    sourceRoot,
    dependencyRoot: "/review/repo/node_modules",
    outputRoot,
    metafile: {
      inputs: Object.fromEntries(
        names.map((name) => [
          name,
          {
            bytes: Buffer.byteLength(fixtures[name]!),
            imports:
              name === ESM
                ? [
                    {
                      path: MAIN,
                      kind: "import-statement",
                      original: "../lib/index.js",
                    },
                  ]
                : name === MAIN
                  ? [
                      {
                        path: NATIVE,
                        kind: "require-call",
                        original: "./native",
                      },
                    ]
                  : name === NATIVE
                    ? [
                        {
                          path: CLIENT,
                          kind: "require-call",
                          original: "./client",
                        },
                      ]
                    : [
                        {
                          path: "pg-native",
                          kind: "require-call",
                          external: true,
                        },
                      ],
          },
        ]),
      ),
      outputs: {
        [outputKey]: {
          bytes: output.length,
          imports: [
            { path: "pg-native", kind: "require-call", external: true },
          ],
          inputs: Object.fromEntries(
            names.map((name) => [name, { bytesInOutput: 8 }]),
          ),
        },
        [mapKey]: { bytes: sourceMap.length, imports: [], inputs: {} },
      },
    },
    sources: Object.fromEntries(
      names.map((name) => [name, Buffer.from(fixtures[name]!)]),
    ),
    outputs: [
      {
        metafilePath: outputKey,
        bytes: output,
        sourceMap: { metafilePath: mapKey, bytes: sourceMap },
      },
    ],
    registeredModuleNames: ["chunks/pg-test.js"],
  };
}
function editMap(e: OptionalPgEvidence, change: (map: any) => void) {
  const map = JSON.parse(Buffer.from(e.outputs[0]!.sourceMap.bytes).toString());
  change(map);
  const bytes = Buffer.from(JSON.stringify(map));
  e.outputs[0]!.sourceMap.bytes = bytes;
  e.metafile.outputs[mapKey]!.bytes = bytes.length;
}
function editOutput(e: OptionalPgEvidence, value: string) {
  const bytes = Buffer.from(value);
  e.outputs[0]!.bytes = bytes;
  e.metafile.outputs[outputKey]!.bytes = bytes.length;
}
function discardedSample(contributing = true): OptionalPgEvidence {
  const e = sample();
  e.discardedInputSources = Object.fromEntries(
    Object.entries(discardedFixtures).map(([name, text]) => [
      name,
      Buffer.from(text),
    ]),
  );
  e.erasureConfigSources = Object.fromEntries(
    Object.entries(configFixtures).map(([name, text]) => [
      name,
      Buffer.from(text),
    ]),
  ) as unknown as ErasureConfigSources;
  const sourceNames = Object.keys(DISCARDED_INPUT_SOURCE_PINS);
  for (const name of sourceNames) {
    const rows = DISCARDED_INPUT_RECORD_PINS.filter(
      (pin) => pin.sourcePath === name,
    );
    const length = Math.max(...rows.map((pin) => pin.importIndex)) + 1;
    const imports = Array.from({ length }, () => ({
      path: "node:assert",
      kind: "import-statement",
      external: true,
    }));
    for (const pin of rows)
      imports[pin.importIndex] = {
        path: pin.target,
        kind: pin.kind,
        external: true,
      };
    e.metafile.inputs[name] = {
      bytes: Buffer.byteLength(discardedFixtures[name]!),
      imports,
    };
    if (contributing)
      e.metafile.outputs[outputKey]!.inputs[name] = { bytesInOutput: 8 };
  }
  if (contributing) {
    editOutput(
      e,
      Buffer.from(e.outputs[0]!.bytes).toString() +
        sourceNames.map((_, index) => `let source${index}=0;\n`).join(""),
    );
    editMap(e, (map) => {
      for (const source of sourceNames) {
        map.sources.push(
          path.relative(
            path.dirname(path.resolve(e.sourceRoot, outputKey)),
            path.resolve(e.sourceRoot, source),
          ),
        );
        map.sourcesContent.push(discardedFixtures[source]);
      }
      map.mappings +=
        ";" +
        sourceNames
          .map((_, index) =>
            (index === 0 ? [0, 1, -6, -11] : [0, 1, 0, 0]).map(vlq).join(""),
          )
          .join(";");
    });
  }
  return e;
}
const stageMutations: [
  (typeof OPTIONAL_PROOF_STAGES)[number],
  (e: OptionalPgEvidence) => void,
][] = [
  [
    "discarded-inputs",
    (e) => {
      Object.assign(e, discardedSample());
      e.discardedInputSources = {};
    },
  ],
  [
    "erasure-config",
    (e) => {
      Object.assign(e, discardedSample());
      delete e.erasureConfigSources;
    },
  ],
  [
    "roots",
    (e) => {
      e.sourceRoot = "relative";
    },
  ],
  [
    "inventory",
    (e) => {
      e.metafile.inputs = {};
    },
  ],
  [
    "external-imports",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports.push({
        path: "bufferutil",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "module-inventory",
    (e) => {
      e.registeredModuleNames.push(e.registeredModuleNames[0]!);
    },
  ],
  [
    "source-identities",
    (e) => {
      e.metafile.inputs["../unreviewed/file.js"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "input-edges",
    (e) => {
      e.metafile.inputs[NATIVE]!.imports[0]!.path =
        "node_modules/nonexistent.js";
    },
  ],
  [
    "source-pins",
    (e) => {
      e.sources[MAIN] = Buffer.from("altered");
    },
  ],
  [
    "pinned-edges",
    (e) => {
      e.metafile.inputs[ESM]!.imports[0]!.kind = "require-call";
    },
  ],
  [
    "optional-input",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports.push({
        path: "pg-native",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "output-inventory",
    (e) => {
      e.outputs = [];
    },
  ],
  [
    "output-bytes",
    (e) => {
      e.metafile.outputs[outputKey]!.bytes++;
    },
  ],
  [
    "source-map",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "?";
      }),
  ],
  [
    "contributions",
    (e) =>
      editMap(e, (map) => {
        map.sourcesContent[0] += "\n";
      }),
  ],
  [
    "optional-output",
    (e) => {
      e.metafile.outputs[outputKey]!.imports[0]!.kind = "dynamic-import";
    },
  ],
  [
    "completeness",
    (e) => {
      e.metafile.outputs[outputKey]!.imports.push({
        path: "pg-native",
        kind: "require-call",
        external: true,
      });
    },
  ],
];
test("every frozen proof stage has an explicit failing fixture", () => {
  assert.deepEqual(
    stageMutations.map(([stage]) => stage).sort(),
    [...OPTIONAL_PROOF_STAGES].sort(),
  );
});
for (const [stage, mutate] of stageMutations) {
  test("fixed proof refusal stage: " + stage, () => {
    const e = sample();
    mutate(e);
    assert.throws(
      () => validateOptionalPgNativeImport(e),
      (error) => {
        assert.ok(error instanceof Error);
        const markers = optionalProofDiagnosticMarkers(error).split("\n");
        assert.equal(markers[0], `[owner-optional-proof-failed:${stage}]`);
        assert.equal(
          markers.filter((line) =>
            line.startsWith("[owner-optional-proof-failed:"),
          ).length,
          1,
        );
        assert.equal(
          markers.filter((line) =>
            line.startsWith("[owner-optional-import-counts:input:"),
          ).length,
          1,
        );
        assert.equal(
          markers.filter((line) =>
            line.startsWith("[owner-optional-import-counts:output:"),
          ).length,
          1,
        );
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  });
}
for (const stage of [
  "output-bytes",
  "source-map",
  "contributions",
  "optional-output",
] as const) {
  test("per-output proof stage resets on second output: " + stage, () => {
    const e = sample();
    const secondKey = outputKey.replace("pg-test.js", "second.js");
    const secondMapKey = secondKey + ".map";
    const secondInfo = structuredClone(e.metafile.outputs[outputKey]!);
    secondInfo.imports = [];
    e.metafile.outputs[secondKey] = secondInfo;
    e.metafile.outputs[secondMapKey] = structuredClone(
      e.metafile.outputs[mapKey]!,
    );
    const secondOutput = {
      metafilePath: secondKey,
      bytes: Buffer.from(e.outputs[0]!.bytes),
      sourceMap: {
        metafilePath: secondMapKey,
        bytes: Buffer.from(e.outputs[0]!.sourceMap.bytes),
      },
    };
    e.outputs.push(secondOutput);
    e.registeredModuleNames.push("chunks/second.js");
    if (stage === "output-bytes") secondInfo.bytes++;
    if (stage === "source-map") {
      secondOutput.sourceMap.bytes = Buffer.from("{");
      e.metafile.outputs[secondMapKey]!.bytes = 1;
    }
    if (stage === "contributions")
      secondInfo.inputs[CLIENT]!.bytesInOutput = -1;
    if (stage === "optional-output")
      secondInfo.imports = [
        { path: "pg-native", kind: "dynamic-import", external: true },
      ];
    assert.throws(
      () => validateOptionalPgNativeImport(e),
      (error) => {
        assert.equal(
          optionalProofDiagnosticMarkers(error).split("\n")[0],
          `[owner-optional-proof-failed:${stage}]`,
        );
        return true;
      },
    );
  });
}
function canonicalSample(): OptionalPgEvidence {
  const e = sample();
  e.dependencyRoot = "/review/qualification-base/node_modules";
  const actual = (name: string) =>
    path.relative(
      e.sourceRoot,
      path.join(e.dependencyRoot, name.slice("node_modules/".length)),
    );
  e.metafile.inputs = Object.fromEntries(
    Object.entries(e.metafile.inputs).map(([name, info]) => [
      actual(name),
      {
        ...info,
        imports: info.imports.map((item) => ({
          ...item,
          path: names.includes(item.path) ? actual(item.path) : item.path,
        })),
      },
    ]),
  );
  e.metafile.outputs[outputKey]!.inputs = Object.fromEntries(
    names.map((name) => [actual(name), { bytesInOutput: 8 }]),
  );
  editMap(e, (map) => {
    map.sources = names.map((name) =>
      path.relative(
        "/tmp/raw-owner-qualification-Ab12/modules/chunks",
        path.join(e.dependencyRoot, name.slice("node_modules/".length)),
      ),
    );
  });
  return e;
}
const canonicalKey = (logical: string) => "../qualification-base/" + logical;

test("canonical dependency-root metadata inputs, branch edges and contributions pass unchanged", () => {
  const e = canonicalSample();
  const before = JSON.stringify(e.metafile);
  const result = validateOptionalPgNativeImport(e);
  assert.equal(result?.admitted.output, outputKey);
  assert.equal(result?.admitted.importIndex, 0);
  assert.equal(JSON.stringify(e.metafile), before);
});
test("logical custody bytes work with canonical metadata and logical map paths", () => {
  const e = canonicalSample();
  editMap(e, (map) => {
    map.sources = names.map((name) =>
      path.relative(
        "/tmp/raw-owner-qualification-Ab12/modules/chunks",
        path.resolve(e.sourceRoot, name),
      ),
    );
  });
  assert.ok(validateOptionalPgNativeImport(e));
});
test("source identity accepts only exact project and dependency descendants", () => {
  assert.equal(
    ownerSourceIdentity(
      "/review/repo",
      "/review/qualification-base/node_modules",
      "workers/api.ts",
    ),
    "workers/api.ts",
  );
  assert.equal(
    ownerSourceIdentity(
      "/review/repo",
      "/review/qualification-base/node_modules",
      CLIENT,
    ),
    CLIENT,
  );
  assert.equal(
    ownerSourceIdentity(
      "/review/repo",
      "/review/qualification-base/node_modules",
      canonicalKey(CLIENT),
    ),
    CLIENT,
  );
  assert.equal(
    ownerSourceIdentity("/review/repo", "/review/repo/node_modules", CLIENT),
    CLIENT,
  );
});
const badIdentities: [string, string, string][] = [
  ["/review/repo/", "/review/qualification-base/node_modules", CLIENT],
  ["/review/repo", "/review/qualification-base/node_modules/", CLIENT],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../unreviewed/node_modules/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../qualification-base/node_modules-evil/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../repo-evil/workers/api.ts",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../qualification-base/node_modules/pg/../pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../qualification-base//node_modules/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "./node_modules/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "/review/qualification-base/node_modules/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "node_modules/pg/lib/native/client.js/",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "../qualification-base/node_modules/../../outside.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "file:///review/repo/node_modules/pg/lib/native/client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "node_modules\\pg\\lib\\native\\client.js",
  ],
  [
    "/review/repo",
    "/review/qualification-base/node_modules",
    "node_modules/pg/lib/native/client.js\u0000",
  ],
  ["/", "/review/qualification-base/node_modules", CLIENT],
  ["/review/repo", "/", CLIENT],
  ["review/repo", "/review/qualification-base/node_modules", CLIENT],
  ["/review/repo/../repo", "/review/qualification-base/node_modules", CLIENT],
  [
    "/review/repo",
    "/review/qualification-base/../qualification-base/node_modules",
    CLIENT,
  ],
  ["/review/repo", "/review/repo", CLIENT],
  ["/review/repo", "/review", CLIENT],
];
for (const [index, args] of badIdentities.entries()) {
  test(`source identity rejects unreviewed path or root ${index + 1}`, () => {
    assert.throws(() => ownerSourceIdentity(...args));
  });
}
const badCanonicalGraphs: [string, (e: OptionalPgEvidence) => void][] = [
  [
    "extra logical edge alongside canonical edge",
    (e) => {
      e.metafile.inputs[canonicalKey(NATIVE)]!.imports.push({
        path: CLIENT,
        kind: "require-call",
      });
    },
  ],
  [
    "extra dot-spelled edge alongside canonical edge",
    (e) => {
      e.metafile.inputs[canonicalKey(NATIVE)]!.imports.push({
        path: "../qualification-base/./" + CLIENT,
        kind: "require-call",
      });
    },
  ],
  [
    "simultaneous logical and canonical inputs",
    (e) => {
      e.metafile.inputs[CLIENT] = e.metafile.inputs[canonicalKey(CLIENT)]!;
    },
  ],
  [
    "logical edge alias without matching input key",
    (e) => {
      e.metafile.inputs[canonicalKey(NATIVE)]!.imports[0]!.path = CLIENT;
    },
  ],
  [
    "wrong-root branch edge",
    (e) => {
      e.metafile.inputs[canonicalKey(NATIVE)]!.imports[0]!.path =
        "../wrong-base/" + CLIENT;
    },
  ],
  [
    "dot-spelled branch edge",
    (e) => {
      e.metafile.inputs[canonicalKey(NATIVE)]!.imports[0]!.path =
        "../qualification-base/./" + CLIENT;
    },
  ],
  [
    "logical contribution alias",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs[CLIENT] = { bytesInOutput: 8 };
    },
  ],
  [
    "canonical contributor replaced with logical alias",
    (e) => {
      delete e.metafile.outputs[outputKey]!.inputs[canonicalKey(CLIENT)];
      e.metafile.outputs[outputKey]!.inputs[CLIENT] = { bytesInOutput: 8 };
    },
  ],
  [
    "contribution outside exact dependency root",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs["../other/" + CLIENT] = {
        bytesInOutput: 8,
      };
    },
  ],
  [
    "unrelated input outside both roots",
    (e) => {
      e.metafile.inputs["../unrelated/same.js"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "source-root prefix collision input",
    (e) => {
      e.metafile.inputs["../repo-evil/same.js"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "dependency-root prefix collision input",
    (e) => {
      e.metafile.inputs["../qualification-base/node_modules-evil/same.js"] = {
        bytes: 1,
        imports: [],
      };
    },
  ],
  [
    "canonical key interior traversal",
    (e) => {
      e.metafile.inputs[
        "../qualification-base/node_modules/pg/../pg/lib/native/client.js"
      ] = e.metafile.inputs[canonicalKey(CLIENT)]!;
      delete e.metafile.inputs[canonicalKey(CLIENT)];
    },
  ],
  [
    "canonical key double slash",
    (e) => {
      e.metafile.inputs["../qualification-base//" + CLIENT] =
        e.metafile.inputs[canonicalKey(CLIENT)]!;
      delete e.metafile.inputs[canonicalKey(CLIENT)];
    },
  ],
  [
    "wrong root supplied to reinterpret canonical keys",
    (e) => {
      e.dependencyRoot = "/review/different-base/node_modules";
    },
  ],
  [
    "duplicate logical and canonical map entries",
    (e) =>
      editMap(e, (map) => {
        map.sources.push(
          path.relative(
            "/tmp/raw-owner-qualification-Ab12/modules/chunks",
            path.join(e.sourceRoot, CLIENT),
          ),
        );
        map.sourcesContent.push(fixtures[CLIENT]);
      }),
  ],
  [
    "invented native builtin namespace",
    (e) => {
      e.metafile.inputs["native-node-require:made-up"] = {
        bytes: 1,
        imports: [],
      };
    },
  ],
];
for (const [label, mutate] of badCanonicalGraphs) {
  test("canonical metadata fails closed: " + label, () => {
    const e = canonicalSample();
    mutate(e);
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
}
test("synthetic positive: pins, exact input/output and mapped optional call are associated", () => {
  const result = validateOptionalPgNativeImport(sample());
  assert.equal(result?.admitted.output, outputKey);
  assert.equal(result?.admitted.importIndex, 0);
  assert.equal(result?.universallyClosedGraph, false);
  assert.equal(result?.branchInactivityProven, false);
});
test("no pg-native anywhere grants no exception and needs no pg provenance", () => {
  const e = sample();
  e.metafile.inputs = { "workers/api.entry.ts": { bytes: 1, imports: [] } };
  e.metafile.outputs[outputKey]!.imports = [];
  delete (e.metafile.inputs["workers/api.entry.ts"] as any).imports;
  e.sources = {};
  assert.equal(validateOptionalPgNativeImport(e), null);
});
test("pinned maps support a canonical distinct dependency root", () => {
  const e = sample();
  e.dependencyRoot = "/shared/dependencies";
  editMap(e, (map) => {
    map.sources = names.map((name) =>
      path.relative(
        "/tmp/raw-owner-qualification-Ab12/modules/chunks",
        path.join(e.dependencyRoot, name.slice("node_modules/".length)),
      ),
    );
  });
  assert.ok(validateOptionalPgNativeImport(e));
});
const negatives: [string, (e: OptionalPgEvidence) => void][] = [
  [
    "missing source bytes",
    (e) => {
      delete e.sources[CLIENT];
    },
  ],
  [
    "altered installed source",
    (e) => {
      e.sources[CLIENT] = Buffer.from(fixtures[CLIENT] + "\n");
    },
  ],
  [
    "altered ESM wrapper",
    (e) => {
      e.sources[ESM] = Buffer.from("export default {};");
    },
  ],
  [
    "wrong source input bytes",
    (e) => {
      e.metafile.inputs[CLIENT]!.bytes++;
    },
  ],
  [
    "missing source input",
    (e) => {
      delete e.metafile.inputs[CLIENT];
    },
  ],
  [
    "input path alias",
    (e) => {
      e.metafile.inputs["/review/repo/" + CLIENT] = e.metafile.inputs[CLIENT]!;
    },
  ],
  [
    "missing native-index edge",
    (e) => {
      e.metafile.inputs[NATIVE]!.imports = [];
    },
  ],
  [
    "native-index edge externalized",
    (e) => {
      e.metafile.inputs[NATIVE]!.imports[0]!.external = true;
    },
  ],
  [
    "entry edge require instead of import",
    (e) => {
      e.metafile.inputs[ESM]!.imports[0]!.kind = "require-call";
    },
  ],
  [
    "missing input import provenance",
    (e) => {
      delete (e.metafile.inputs[CLIENT] as any).imports;
    },
  ],
  [
    "extra external package input",
    (e) => {
      e.metafile.inputs[MAIN]!.imports.push({
        path: "bufferutil",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "mapping negative source index",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "ADAA";
      }),
  ],
  [
    "mapping invalid segment arity",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "AA";
      }),
  ],
  [
    "mapping negative generated column",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "DAAA";
      }),
  ],
  [
    "mapping original line beyond source",
    (e) =>
      editMap(e, (map) => {
        map.mappings = [0, 0, 999999, 0].map(vlq).join("");
      }),
  ],
  [
    "mapping original column beyond source",
    (e) =>
      editMap(e, (map) => {
        map.mappings = [0, 0, 0, 999999].map(vlq).join("");
      }),
  ],
  [
    "mapping nonexistent name index",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "AAAAA";
      }),
  ],
  [
    "missing optional input",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports = [];
    },
  ],
  [
    "duplicate optional input",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports.push({
        path: "pg-native",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "optional input import-statement",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports[0]!.kind = "import-statement";
    },
  ],
  [
    "optional input dynamic-import",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports[0]!.kind = "dynamic-import";
    },
  ],
  [
    "optional input not external",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports[0]!.external = false;
    },
  ],
  [
    "different input importer",
    (e) => {
      e.metafile.inputs[MAIN]!.imports.push(
        e.metafile.inputs[CLIENT]!.imports.pop()!,
      );
    },
  ],
  [
    "additional optional importer",
    (e) => {
      e.metafile.inputs["src/evil.ts"] = {
        bytes: 1,
        imports: [{ path: "pg-native", kind: "require-call", external: true }],
      };
    },
  ],
  [
    "original pg-native redirected",
    (e) => {
      e.metafile.inputs[CLIENT]!.imports[0]!.path = "some-alias";
      e.metafile.inputs[CLIENT]!.imports[0]!.original = "pg-native";
    },
  ],
  [
    "native package supplied as input",
    (e) => {
      e.metafile.inputs["node_modules/pg-native/index.js"] = {
        bytes: 1,
        imports: [],
      };
    },
  ],
  [
    "native addon supplied as input",
    (e) => {
      e.metafile.inputs["node_modules/pg/build/Release/pg.node"] = {
        bytes: 1,
        imports: [],
      };
    },
  ],
  [
    "native alias supplied at runtime",
    (e) => {
      e.registeredModuleNames.push("pg-native");
    },
  ],
  [
    "addon supplied at runtime",
    (e) => {
      e.registeredModuleNames.push("pg.node");
    },
  ],
  [
    "extra runtime module",
    (e) => {
      e.registeredModuleNames.push("different.js");
    },
  ],
  [
    "duplicate runtime module",
    (e) => {
      e.registeredModuleNames.push("chunks/pg-test.js");
    },
  ],
  [
    "importing output unregistered",
    (e) => {
      e.registeredModuleNames = ["other.js"];
    },
  ],
  [
    "missing output bytes",
    (e) => {
      e.outputs[0]!.bytes = new Uint8Array();
    },
  ],
  [
    "mismatched output byte count",
    (e) => {
      e.metafile.outputs[outputKey]!.bytes++;
    },
  ],
  [
    "missing preserved output",
    (e) => {
      e.outputs = [];
    },
  ],
  [
    "duplicate preserved output",
    (e) => {
      e.outputs.push(e.outputs[0]!);
    },
  ],
  [
    "wrong output map association",
    (e) => {
      e.outputs[0]!.sourceMap.metafilePath = "other.js.map";
    },
  ],
  [
    "missing metadata map",
    (e) => {
      delete e.metafile.outputs[mapKey];
    },
  ],
  [
    "wrong metadata map bytes",
    (e) => {
      e.metafile.outputs[mapKey]!.bytes++;
    },
  ],
  [
    "unrelated map path with matching suffix",
    (e) =>
      editMap(e, (map) => {
        map.sources[3] = "/unrelated/" + CLIENT;
      }),
  ],
  [
    "missing map source",
    (e) =>
      editMap(e, (map) => {
        map.sources.pop();
        map.sourcesContent.pop();
      }),
  ],
  [
    "null map source content",
    (e) =>
      editMap(e, (map) => {
        map.sourcesContent[3] = null;
      }),
  ],
  [
    "modified map source content",
    (e) =>
      editMap(e, (map) => {
        map.sourcesContent[3] += "\n";
      }),
  ],
  [
    "duplicate map source alias",
    (e) =>
      editMap(e, (map) => {
        map.sources.push(map.sources[3]);
        map.sourcesContent.push(map.sourcesContent[3]);
      }),
  ],
  [
    "sourceRoot rewrite",
    (e) =>
      editMap(e, (map) => {
        map.sourceRoot = "/forged";
      }),
  ],
  [
    "indexed map",
    (e) =>
      editMap(e, (map) => {
        map.sections = [];
      }),
  ],
  [
    "missing mappings",
    (e) =>
      editMap(e, (map) => {
        delete map.mappings;
      }),
  ],
  [
    "source content without mapped output",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "AAAA;ACAA;ACAA";
      }),
  ],
  [
    "mapped native client but no require-line mapping",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "AAAA;ACAA;ACAA;MCAA";
      }),
  ],
  [
    "require mapping away from emitted call",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "AAAA;ACAA;ACAA;ACMW";
      }),
  ],
  [
    "malformed VLQ",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "?";
      }),
  ],
  [
    "unterminated VLQ",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "g";
      }),
  ],
  [
    "mapping beyond generated text",
    (e) =>
      editMap(e, (map) => {
        map.mappings = "++++/DAAA";
      }),
  ],
  [
    "zero native-client contribution",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs[CLIENT]!.bytesInOutput = 0;
    },
  ],
  [
    "missing native-client contribution",
    (e) => {
      delete e.metafile.outputs[outputKey]!.inputs[CLIENT];
    },
  ],
  [
    "negative contribution",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs[CLIENT]!.bytesInOutput = -1;
    },
  ],
  [
    "fractional contribution",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs[CLIENT]!.bytesInOutput = 0.5;
    },
  ],
  [
    "zero main contribution",
    (e) => {
      e.metafile.outputs[outputKey]!.inputs[MAIN]!.bytesInOutput = 0;
    },
  ],
  [
    "optional output import-statement",
    (e) => {
      e.metafile.outputs[outputKey]!.imports[0]!.kind = "import-statement";
    },
  ],
  [
    "optional output dynamic-import",
    (e) => {
      e.metafile.outputs[outputKey]!.imports[0]!.kind = "dynamic-import";
    },
  ],
  [
    "optional output not external",
    (e) => {
      e.metafile.outputs[outputKey]!.imports[0]!.external = false;
    },
  ],
  [
    "duplicate optional output",
    (e) => {
      e.metafile.outputs[outputKey]!.imports.push({
        path: "pg-native",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "missing optional output",
    (e) => {
      e.metafile.outputs[outputKey]!.imports = [];
    },
  ],
  [
    "other optional external package",
    (e) => {
      e.metafile.outputs[outputKey]!.imports.push({
        path: "bufferutil",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "map hides optional output",
    (e) => {
      e.metafile.outputs[mapKey]!.imports.push({
        path: "pg-native",
        kind: "require-call",
        external: true,
      });
    },
  ],
  [
    "no actual emitted call",
    (e) =>
      editOutput(e, 'let a=1;\nlet b=2;\nlet c=3;\nlet d=q("other-pkg");\n'),
  ],
  [
    "duplicate emitted call",
    (e) =>
      editOutput(
        e,
        'let a=1;\nlet b=2;\nlet c=3;\nlet d=q("pg-native");q("pg-native");\n',
      ),
  ],
  [
    "unreviewed output root",
    (e) => {
      e.outputRoot = "/tmp/something-else";
    },
  ],
];
for (const [label, mutate] of negatives) {
  test("fails closed: " + label, () => {
    const e = sample();
    mutate(e);
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
}

const discardedNames = Object.keys(DISCARDED_INPUT_SOURCE_PINS);
const fixedReadIdentities = new Map(discardedNames.map((name) => [name, name]));
test("fixed discarded-input pins are deeply frozen", () => {
  for (const value of [
    DISCARDED_INPUT_SOURCE_PINS,
    ERASURE_CONFIG_SOURCE_PINS,
    DISCARDED_INPUT_RECORD_PINS,
    DISCARDED_INPUT_LIMITS,
  ])
    assert.ok(Object.isFrozen(value));
  for (const value of [
    ...Object.values(DISCARDED_INPUT_SOURCE_PINS),
    ...Object.values(ERASURE_CONFIG_SOURCE_PINS),
    ...DISCARDED_INPUT_RECORD_PINS,
  ])
    assert.ok(Object.isFrozen(value));
  assert.equal(discardedNames.length, 20);
  assert.equal(DISCARDED_INPUT_RECORD_PINS.length, 33);
});
test("complete source-reviewed batch preserves the exact existing pg result shape", () => {
  const e = discardedSample();
  const result = validateOptionalPgNativeImport(e)!;
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "kind",
      "package",
      "universallyClosedGraph",
      "branchInactivityProven",
      "admitted",
    ].sort(),
  );
  assert.equal(result.admitted.output, outputKey);
  assert.equal(result.admitted.importIndex, 0);
  assert.equal(result.universallyClosedGraph, false);
  assert.equal(result.branchInactivityProven, false);
  assert.deepEqual(Object.keys(e.sources).sort(), names.slice().sort());
});
test("zero-contribution discarded importers retain custody without an emitted-source requirement", () => {
  const e = discardedSample(false);
  assert.ok(validateOptionalPgNativeImport(e));
});
test("exact-batch read plan returns only fixed actual/logical source keys and config paths", () => {
  const e = discardedSample();
  const plan = planDiscardedInputReads(e.metafile, fixedReadIdentities)!;
  assert.deepEqual(
    plan.sources,
    discardedNames.map((logical) => ({ logical, actual: logical })),
  );
  assert.deepEqual(plan.configs, Object.keys(ERASURE_CONFIG_SOURCE_PINS));
  assert.deepEqual(Object.keys(plan).sort(), ["configs", "sources"]);
});
test("read plan is not a substitute for bytes, config or full pg proof", () => {
  const e = discardedSample();
  delete e.erasureConfigSources;
  delete e.discardedInputSources;
  assert.ok(planDiscardedInputReads(e.metafile, fixedReadIdentities));
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("pg-only graph has no read plan and preserves its success", () => {
  const e = sample();
  assert.equal(planDiscardedInputReads(e.metafile, fixedReadIdentities), null);
  assert.ok(validateOptionalPgNativeImport(e));
});
test("empty new evidence fields do not alter existing success", () => {
  const e = sample();
  e.discardedInputSources = {};
  e.erasureConfigSources = {} as ErasureConfigSources;
  assert.ok(validateOptionalPgNativeImport(e));
});
test("evidence without a pending reviewed batch is refused", () => {
  for (const field of [
    "discardedInputSources",
    "erasureConfigSources",
  ] as const) {
    const e = sample();
    (e as any)[field] = { secret: new Uint8Array(1) };
    assert.throws(() => validateOptionalPgNativeImport(e));
  }
});
for (const [rowIndex, pin] of DISCARDED_INPUT_RECORD_PINS.entries()) {
  for (const mutation of [
    "target",
    "kind",
    "external",
    "original",
    "index",
    "missing",
  ] as const) {
    test(`discarded tuple ${rowIndex} rejects changed ${mutation}`, () => {
      const e = discardedSample(false);
      const rows = e.metafile.inputs[pin.sourcePath]!.imports;
      if (mutation === "target")
        rows[pin.importIndex]!.path = pin.target + "-unreviewed";
      if (mutation === "kind") rows[pin.importIndex]!.kind = "require-call";
      if (mutation === "external") rows[pin.importIndex]!.external = false;
      if (mutation === "original")
        rows[pin.importIndex]!.original = "private-alias";
      if (mutation === "index")
        rows.splice(pin.importIndex, 0, {
          path: "node:fs",
          kind: "import-statement",
          external: true,
        });
      if (mutation === "missing")
        rows[pin.importIndex] = {
          path: "node:fs",
          kind: "import-statement",
          external: true,
        };
      assert.equal(
        planDiscardedInputReads(e.metafile, fixedReadIdentities),
        null,
      );
      assert.throws(() => validateOptionalPgNativeImport(e));
    });
  }
}
for (const source of discardedNames) {
  test(`discarded importer pin refuses changed bytes: ${source}`, () => {
    const e = discardedSample(false);
    e.discardedInputSources![source]![0] ^= 1;
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
  test(`discarded importer refuses changed metadata byte count: ${source}`, () => {
    const e = discardedSample(false);
    e.metafile.inputs[source]!.bytes++;
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
  test(`positive discarded importer refuses changed map bytes: ${source}`, () => {
    const e = discardedSample();
    editMap(e, (map) => {
      map.sourcesContent[names.length + discardedNames.indexOf(source)] += "\n";
    });
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
  test(`positive discarded importer refuses missing map association: ${source}`, () => {
    const e = discardedSample();
    editMap(e, (map) => {
      map.sources[names.length + discardedNames.indexOf(source)] +=
        ".unrelated";
    });
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
  test(`positive discarded importer refuses absent genuine mapping: ${source}`, () => {
    const e = discardedSample();
    editMap(e, (map) => {
      // Replace this source's generated segment with an unmapped segment, and
      // preserve the cumulative source index for later still-mapped segments.
      const lines = map.mappings.split(";");
      const i = names.length + discardedNames.indexOf(source);
      lines[i] = "A";
      if (i + 1 < lines.length) {
        const fields = i === names.length ? [0, 2, -6, -11] : [0, 2, 0, 0];
        lines[i + 1] = fields.map(vlq).join("");
      }
      map.mappings = lines.join(";");
    });
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
}
for (const source of Object.keys(
  ERASURE_CONFIG_SOURCE_PINS,
) as (keyof typeof ERASURE_CONFIG_SOURCE_PINS)[]) {
  test(`erasure config refuses changed bytes: ${source}`, () => {
    const e = discardedSample(false);
    e.erasureConfigSources![source][0] ^= 1;
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
  test(`erasure config refuses missing source: ${source}`, () => {
    const e = discardedSample(false);
    delete (e.erasureConfigSources as any)[source];
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
}
test("no pending discarded batch can pass the no-pg null branch", () => {
  const e = discardedSample(false);
  e.metafile.inputs[CLIENT]!.imports = [];
  e.metafile.outputs[outputKey]!.imports = [];
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("partial known batch refuses before success and returns no read plan", () => {
  const e = discardedSample(false);
  const pin = DISCARDED_INPUT_RECORD_PINS[0];
  e.metafile.inputs[pin.sourcePath]!.imports[pin.importIndex] = {
    path: "node:fs",
    kind: "import-statement",
    external: true,
  };
  assert.equal(planDiscardedInputReads(e.metafile, fixedReadIdentities), null);
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("unknown tuple retains original branded refusal without source reads", () => {
  const e = sample();
  e.metafile.inputs[MAIN]!.imports.push({
    path: "clsx",
    kind: "import-statement",
    external: true,
  });
  let touched = 0;
  Object.defineProperty(e, "discardedInputSources", {
    get() {
      touched++;
      throw Error("private");
    },
  });
  assert.equal(planDiscardedInputReads(e.metafile, fixedReadIdentities), null);
  assert.throws(
    () => validateOptionalPgNativeImport(e),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message.split("\n")[0],
        "[owner-optional-proof-failed:external-imports]",
      );
      assert.ok(error.cause instanceof Error);
      assert.equal(
        error.cause.message,
        optionalPgExternalRefusalMarker("input", "clsx"),
      );
      return true;
    },
  );
  assert.equal(touched, 0);
});
test("a different importer cannot borrow the exact target/index", () => {
  const e = discardedSample(false);
  const pin = DISCARDED_INPUT_RECORD_PINS[0];
  e.metafile.inputs["src/unreviewed.ts"] = e.metafile.inputs[pin.sourcePath]!;
  delete e.metafile.inputs[pin.sourcePath];
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("canonical alias cannot duplicate an importer", () => {
  const e = discardedSample(false);
  e.metafile.inputs["./" + discardedNames[0]] =
    e.metafile.inputs[discardedNames[0]!]!;
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("extra source or config evidence is refused", () => {
  for (const field of [
    "discardedInputSources",
    "erasureConfigSources",
  ] as const) {
    const e = discardedSample(false);
    (e[field] as any)["unreviewed"] = Buffer.from("x");
    assert.throws(() => validateOptionalPgNativeImport(e));
  }
});
test("extra source-map alias is refused for a reviewed importer", () => {
  const e = discardedSample();
  editMap(e, (map) => {
    map.sources.push(map.sources[4]);
    map.sourcesContent.push(map.sourcesContent[4]);
  });
  assert.throws(() => validateOptionalPgNativeImport(e));
});
for (const scope of ["js", "map", "wasm"] as const)
  for (const external of [true, false])
    test(`discarded target equality refuses ${scope} output external=${external}`, () => {
      const e = discardedSample(false);
      const key =
        scope === "js"
          ? outputKey
          : scope === "map"
            ? mapKey
            : outputKey.replace(/\.js$/, ".wasm");
      if (scope === "wasm") {
        e.metafile.outputs[key] = { bytes: 1, imports: [], inputs: {} };
        e.registeredModuleNames.push("chunks/pg-test.wasm");
      }
      e.metafile.outputs[key]!.imports.push({
        path: DISCARDED_INPUT_RECORD_PINS[0].target,
        kind: "import-statement",
        external,
      });
      assert.equal(
        planDiscardedInputReads(e.metafile, fixedReadIdentities),
        null,
      );
      assert.throws(() => validateOptionalPgNativeImport(e));
    });
for (const [label, mutate] of negatives)
  test("valid discarded batch cannot bypass old refusal: " + label, () => {
    const e = discardedSample();
    mutate(e);
    assert.throws(() => validateOptionalPgNativeImport(e));
  });
test("read plan rejects malformed scopes, complete-scan budgets and duplicate identity values", () => {
  const e = discardedSample(false);
  assert.equal(
    planDiscardedInputReads(
      e.metafile,
      new Map([...fixedReadIdentities, ["alias", discardedNames[0]!]]),
    ),
    null,
  );
  for (const mutate of [
    (e: OptionalPgEvidence) => {
      e.metafile.outputs[outputKey]!.imports.push({
        path: "x",
        kind: "import-statement",
        external: "yes" as any,
      });
    },
    (e: OptionalPgEvidence) => {
      e.metafile.outputs[outputKey]!.imports = new Array(1);
    },
    (e: OptionalPgEvidence) => {
      e.metafile.outputs[outputKey]!.imports = Array.from(
        { length: 65537 },
        () => ({ path: "node:fs", kind: "import-statement", external: true }),
      );
    },
    (e: OptionalPgEvidence) => {
      Object.defineProperty(e.metafile.outputs, "hidden", {
        value: { bytes: 0, imports: [] },
      });
    },
  ]) {
    const e = discardedSample(false);
    mutate(e);
    assert.equal(
      planDiscardedInputReads(e.metafile, fixedReadIdentities),
      null,
    );
  }
});
test("read plan rejects proxies and accessors without running traps", () => {
  let calls = 0;
  const proxy = <T extends object>(value: T) =>
    new Proxy(value, {
      get() {
        calls++;
        throw Error("private");
      },
      ownKeys() {
        calls++;
        throw Error("private");
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("private");
      },
    });
  const e = discardedSample(false);
  assert.equal(
    planDiscardedInputReads(proxy(e.metafile), fixedReadIdentities),
    null,
  );
  assert.equal(
    planDiscardedInputReads(e.metafile, proxy(fixedReadIdentities)),
    null,
  );
  Object.defineProperty(e.metafile.inputs[discardedNames[0]!]!, "imports", {
    get() {
      calls++;
      throw Error("private");
    },
  });
  assert.equal(planDiscardedInputReads(e.metafile, fixedReadIdentities), null);
  assert.equal(calls, 0);
});
test("source/config bytes reject proxy, accessor, shared and oversized values", () => {
  let calls = 0;
  for (const field of [
    "discardedInputSources",
    "erasureConfigSources",
  ] as const)
    for (const mode of ["proxy", "accessor", "shared", "oversized"]) {
      const e = discardedSample(false);
      const values = e[field] as Record<string, Uint8Array>;
      const first = Object.keys(values)[0]!;
      if (mode === "proxy")
        values[first] = new Proxy(values[first]!, {
          get() {
            calls++;
            throw Error("private");
          },
        });
      if (mode === "accessor")
        Object.defineProperty(values, first, {
          get() {
            calls++;
            throw Error("private");
          },
        });
      if (mode === "shared")
        values[first] = new Uint8Array(new SharedArrayBuffer(1));
      if (mode === "oversized")
        values[first] = new Uint8Array(2 * 1024 * 1024 + 1);
      assert.throws(() => validateOptionalPgNativeImport(e));
    }
  assert.equal(calls, 0);
});
test("inert fixture decoder rejects corruption, wrong inventory, and decompression overflow", () => {
  for (const mutate of [
    (v: any) => v.decodedBytes++,
    (v: any) => (v.decodedSha256 = "0".repeat(64)),
    (v: any) => (v.contents = "!"),
    (v: any) => (v.extra = true),
    (v: any) => (v.decodedBytes = 2 * 1024 * 1024 + 1),
  ]) {
    const value = { ...sourceFixtureEnvelope };
    mutate(value);
    assert.throws(() => decodeInertFixture(value, DISCARDED_INPUT_SOURCE_PINS));
  }
  assert.throws(() =>
    decodeInertFixture(sourceFixtureEnvelope, ERASURE_CONFIG_SOURCE_PINS),
  );
  const overflow = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
  assert.throws(() =>
    decodeInertFixture(
      {
        version: 1,
        encoding: "gzip-base64",
        decodedBytes: 2 * 1024 * 1024,
        decodedSha256: "0".repeat(64),
        contents: gzipSync(overflow).toString("base64"),
      },
      DISCARDED_INPUT_SOURCE_PINS,
    ),
  );
});
test("complete discarded batch works with canonical dependency-root pg metadata", () => {
  const e = discardedSample();
  const canonical = canonicalSample();
  e.dependencyRoot = canonical.dependencyRoot;
  for (const name of names) {
    delete e.metafile.inputs[name];
    delete e.metafile.outputs[outputKey]!.inputs[name];
  }
  Object.assign(e.metafile.inputs, canonical.metafile.inputs);
  Object.assign(
    e.metafile.outputs[outputKey]!.inputs,
    canonical.metafile.outputs[outputKey]!.inputs,
  );
  const canonicalMap = JSON.parse(
    Buffer.from(canonical.outputs[0]!.sourceMap.bytes).toString(),
  );
  editMap(e, (map) => {
    map.sources.splice(0, names.length, ...canonicalMap.sources);
  });
  const before = JSON.stringify(e.metafile);
  assert.ok(validateOptionalPgNativeImport(e));
  assert.equal(JSON.stringify(e.metafile), before);
});
test("reviewed importer mappings can lie away from the erased declaration", () => {
  const e = discardedSample();
  const first = DISCARDED_INPUT_RECORD_PINS.find(
    (row) => row.sourcePath === discardedNames[0],
  )!;
  assert.ok(first.line > 1);
  // Synthetic contributing mappings use source line 1; the actual erased import
  // is later in this pinned source. No mapping at the erased import is needed.
  assert.ok(validateOptionalPgNativeImport(e));
});
test("late output target equality cannot hide behind earlier builtin imports", () => {
  const e = discardedSample(false);
  e.metafile.outputs[mapKey]!.imports = [
    { path: "node:fs", kind: "import-statement", external: true },
    {
      path: DISCARDED_INPUT_RECORD_PINS.at(-1)!.target,
      kind: "import-statement",
      external: false,
    },
  ];
  assert.equal(planDiscardedInputReads(e.metafile, fixedReadIdentities), null);
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("partial mappings may not borrow another reviewed source's positive contribution", () => {
  const e = discardedSample();
  editMap(e, (map) => {
    const lines = map.mappings.split(";");
    lines[4] = [0, 2, -6, -11].map(vlq).join("");
    lines[5] = [0, 0, 0, 0].map(vlq).join("");
    map.mappings = lines.join(";");
  });
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("the batch cannot introduce an unreviewed second optional input", () => {
  const e = discardedSample(false);
  e.metafile.inputs[discardedNames[0]!]!.imports.push({
    path: "pg-native",
    kind: "require-call",
    external: true,
  });
  assert.throws(() => validateOptionalPgNativeImport(e));
});
test("reviewed batch is source-identity proof, not evidence that target modules are absent", () => {
  const e = discardedSample();
  e.metafile.inputs["src/history-readers.ts"] = { bytes: 10, imports: [] };
  // This target input may be bundled through another edge while its specific
  // reviewed import declaration remains erased and absent from output imports.
  assert.ok(validateOptionalPgNativeImport(e));
});
