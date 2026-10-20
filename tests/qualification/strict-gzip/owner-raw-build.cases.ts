// Inert synthetic esbuild metadata, source-map JSON and module bytes only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  preserveOwnerBuild,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sources = [
  "workers/api.entry.ts",
  "workers/api.ts",
  "scripts/build-api-worker.ts",
  "src/raw-capture-sync.ts",
  "src/raw-chain-capture.ts",
  "src/raw-capture-d1.ts",
  "wrangler.jsonc",
];
async function fixture(action: (v: any) => Promise<void>) {
  const scratch = mkdtempSync(path.join(tmpdir(), "raw-build-pure-")),
    root = path.join(scratch, "candidate"),
    run = path.join(scratch, "run"),
    outputRoot = path.join(
      scratch,
      "raw-owner-qualification-synthetic/modules",
    ),
    directory = path.join(run, "owner-builds/raw");
  const oldRoot = process.env.DECODER_QUALIFICATION_ROOT,
    oldResult = process.env.DECODER_QUALIFICATION_RESULT;
  try {
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(run);
    for (const source of sources) {
      const f = path.join(root, source);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, `// inert synthetic ${source}\n`);
    }
    process.env.DECODER_QUALIFICATION_ROOT = root;
    process.env.DECODER_QUALIFICATION_RESULT = path.join(
      run,
      "vitest-results.json",
    );
    const modules = [
      {
        name: "api.entry.js",
        type: "ESModule" as const,
        bytes: Buffer.from("export default {};\n"),
      },
      {
        name: "api-lazy.js",
        type: "ESModule" as const,
        bytes: Buffer.from("export const synthetic = 1;\n"),
      },
    ];
    const association: any = {
      kind: "esbuild-api",
      sourceRoot: root,
      dependencyRoot: path.join(root, "node_modules"),
      outputRoot,
      metafile: {
        inputs: Object.fromEntries(
          sources.map((s) => [
            s,
            { bytes: readFileSync(path.join(root, s)).length },
          ]),
        ),
        outputs: {},
      },
      outputs: [],
      sourceMaps: [],
    };
    for (const module of modules) {
      const key = path.join(outputRoot, module.name),
        mapName = module.name + ".map",
        mapKey = path.join(outputRoot, mapName),
        contributing =
          module.name === "api.entry.js"
            ? ["workers/api.entry.ts"]
            : sources.filter((s) => s !== "workers/api.entry.ts");
      const map = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: contributing,
          sourcesContent: contributing.map((s) =>
            readFileSync(path.join(root, s), "utf8"),
          ),
          mappings: "",
        }),
      );
      association.metafile.outputs[key] = {
        bytes: module.bytes.length,
        imports:
          module.name === "api.entry.js"
            ? [{ path: "./api-lazy.js", kind: "dynamic-import" }]
            : [],
        inputs: Object.fromEntries(
          contributing.map((s) => [s, { bytesInOutput: 1 }]),
        ),
        ...(module.name === "api.entry.js"
          ? {
              entryPoint: "workers/api.entry.ts",
              exports: [
                "AlerterHub",
                "ChainFirehoseHub",
                "McpSessionHub",
                "NeonWriteBufferHub",
                "SubnetStatusHub",
                "default",
              ],
            }
          : {}),
      };
      association.metafile.outputs[mapKey] = {
        bytes: map.length,
        imports: [],
        inputs: {},
      };
      association.outputs.push(
        {
          metafilePath: key,
          name: module.name,
          type: "ESModule",
          sourceMapName: mapName,
          sha256: hash(module.bytes),
        },
        {
          metafilePath: mapKey,
          name: mapName,
          type: "SourceMap",
          sourceMapName: null,
          sha256: hash(map),
        },
      );
      association.sourceMaps.push({
        name: mapName,
        base64: map.toString("base64"),
      });
    }
    preserveOwnerBuild("raw", "api.entry.js", modules, sources, {
      kind: "api-builder",
      bytes: Buffer.from(JSON.stringify(association)),
    });
    const save = () => {
      const bytes = Buffer.from(JSON.stringify(association));
      writeFileSync(path.join(directory, "association.bin"), bytes);
      const mf = JSON.parse(
        readFileSync(path.join(directory, "manifest.json"), "utf8"),
      );
      mf.association.bytes = bytes.length;
      mf.association.sha256 = hash(bytes);
      writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(mf));
    };
    await action({
      root,
      directory,
      association,
      save,
      entry:
        association.metafile.outputs[path.join(outputRoot, "api.entry.js")],
      lazy: association.metafile.outputs[path.join(outputRoot, "api-lazy.js")],
    });
  } finally {
    if (oldRoot === undefined) delete process.env.DECODER_QUALIFICATION_ROOT;
    else process.env.DECODER_QUALIFICATION_ROOT = oldRoot;
    if (oldResult === undefined)
      delete process.env.DECODER_QUALIFICATION_RESULT;
    else process.env.DECODER_QUALIFICATION_RESULT = oldResult;
    rmSync(scratch, { recursive: true, force: true });
  }
}
test("accepts exact inert raw builder association with lazy owner closure", async () =>
  fixture(async ({ root, directory }) => {
    assert.equal(
      (await validateOwnerBuild(directory, "raw", root, "a".repeat(64))).modules
        .length,
      2,
    );
  }));
const edits: Record<string, (v: any) => void> = {
  "missing lazy owner contribution": (v) =>
    delete v.lazy.inputs["workers/api.ts"],
  "missing source map bytes": (v) => v.association.sourceMaps.pop(),
  "eager API owner": (v) => (v.entry.imports[0].kind = "import-statement"),
  "unreachable module": (v) => (v.entry.imports = []),
  "external network import": (v) =>
    v.entry.imports.push({
      path: "https://synthetic.invalid/module",
      external: true,
    }),
  "output traversal": (v) => (v.association.outputs[0].name = "../escape.js"),
  "altered module association": (v) =>
    (v.association.outputs[0].sha256 = "f".repeat(64)),
  "altered map association": (v) =>
    (v.association.outputs[1].sha256 = "f".repeat(64)),
  "wrong entry point": (v) => (v.entry.entryPoint = "workers/other.ts"),
  "missing durable export": (v) => v.entry.exports.pop(),
  "foreign input": (v) =>
    (v.association.metafile.inputs["../outside.ts"] = { bytes: 1 }),
  "non builtin generated adapter": (v) =>
    (v.association.metafile.inputs["native-node-require:external-package"] = {
      bytes: 1,
    }),
  "extra output without registered module": (v) => {
    v.association.metafile.outputs[
      path.join(v.association.outputRoot, "extra.js")
    ] = { bytes: 1, imports: [], inputs: {} };
  },
  "missing contributing map source": (v) => {
    const map = JSON.parse(
      Buffer.from(v.association.sourceMaps[1].base64, "base64").toString(),
    );
    const i = map.sources.indexOf("workers/api.ts");
    map.sources.splice(i, 1);
    map.sourcesContent.splice(i, 1);
    const bytes = Buffer.from(JSON.stringify(map));
    v.association.sourceMaps[1].base64 = bytes.toString("base64");
    v.association.metafile.outputs[
      path.join(v.association.outputRoot, "api-lazy.js.map")
    ].bytes = bytes.length;
    v.association.outputs.find(
      (o: any) => o.name === "api-lazy.js.map",
    ).sha256 = hash(bytes);
  },
  "altered source map contents": (v) => {
    const map = JSON.parse(
      Buffer.from(v.association.sourceMaps[1].base64, "base64").toString(),
    );
    map.sourcesContent[0] = "unrelated";
    const bytes = Buffer.from(JSON.stringify(map));
    v.association.sourceMaps[1].base64 = bytes.toString("base64");
    v.association.metafile.outputs[
      path.join(v.association.outputRoot, "api-lazy.js.map")
    ].bytes = bytes.length;
    v.association.outputs.find(
      (o: any) => o.name === "api-lazy.js.map",
    ).sha256 = hash(bytes);
  },
};
for (const [name, edit] of Object.entries(edits))
  test(`refuses raw ${name}`, async () =>
    fixture(async (v) => {
      edit(v);
      v.save();
      await assert.rejects(() =>
        validateOwnerBuild(v.directory, "raw", v.root, "a".repeat(64)),
      );
    }));
test("rejects same-length altered module even with self-consistent manifest", async () =>
  fixture(async ({ root, directory }) => {
    const file = path.join(directory, "module-000.bin"),
      bytes = readFileSync(file);
    bytes[0] ^= 1;
    writeFileSync(file, bytes);
    const manifestFile = path.join(directory, "manifest.json"),
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.modules[0].sha256 = hash(bytes);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    await assert.rejects(() =>
      validateOwnerBuild(directory, "raw", root, "a".repeat(64)),
    );
  }));

for (const nativePath of [
  "pg-native",
  "pg/node_modules/pg-native",
  "pg/lib/node_modules/pg-native",
  "pg/lib/native/node_modules/pg-native",
])
  test("refuses a supplied optional native package without reading or loading it", async () =>
    fixture(async ({ root, directory }) => {
      mkdirSync(path.join(root, "node_modules", nativePath), {
        recursive: true,
      });
      await assert.rejects(() =>
        validateOwnerBuild(directory, "raw", root, "a".repeat(64)),
      );
    }));
test("refuses any host force-native value without mutating it", async () =>
  fixture(async ({ root, directory }) => {
    const previous = process.env.NODE_PG_FORCE_NATIVE;
    try {
      process.env.NODE_PG_FORCE_NATIVE = "synthetic-force-value";
      await assert.rejects(() =>
        validateOwnerBuild(directory, "raw", root, "a".repeat(64)),
      );
      assert.equal(process.env.NODE_PG_FORCE_NATIVE, "synthetic-force-value");
    } finally {
      if (previous === undefined) delete process.env.NODE_PG_FORCE_NATIVE;
      else process.env.NODE_PG_FORCE_NATIVE = previous;
    }
  }));
