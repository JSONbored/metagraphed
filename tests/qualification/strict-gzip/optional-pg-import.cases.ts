import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPTIONAL_PG_SOURCE_PINS,
  validateOptionalPgNativeImport,
  type OptionalPgEvidence,
} from "./optional-pg-import.ts";
const fixtures = JSON.parse(
  readFileSync(
    new URL("./optional-pg-source-fixtures.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;
const names = Object.keys(OPTIONAL_PG_SOURCE_PINS);
const [ESM, MAIN, NATIVE, CLIENT] = names as [string, string, string, string];
const outputKey =
  "../../tmp/raw-owner-qualification-Ab12/modules/chunks/pg-test.js";
const mapKey = outputKey + ".map";
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
