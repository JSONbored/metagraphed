import { OWNER_PG_SOURCES } from "./owner-pg-identity.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  preserveOwnerBuild,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sourceNames = [
  "workers/data-api.ts",
  "wrangler.data.jsonc",
  "src/pg-sql.ts",
  "src/sync-batch-compress.ts",
  "src/strict-gzip-reader.ts",
  ...Object.keys(OWNER_PG_SOURCES).map(
    (relative) => `node_modules/${relative}`,
  ),
];
async function fixture(
  action: (value: {
    root: string;
    directory: string;
    manifest: () => any;
    save: (manifest: any) => void;
    replaceAssociation: (body: Uint8Array) => void;
    upload: (option?: string) => Promise<Uint8Array>;
  }) => Promise<void>,
) {
  const scratch = mkdtempSync(path.join(tmpdir(), "owner-build-pure-")),
    root = path.join(scratch, "candidate"),
    run = path.join(scratch, "run"),
    directory = path.join(run, "owner-builds/queue");
  const oldRoot = process.env.DECODER_QUALIFICATION_ROOT,
    oldResult = process.env.DECODER_QUALIFICATION_RESULT;
  try {
    mkdirSync(root);
    mkdirSync(run);
    for (const name of sourceNames) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      const fixtures = JSON.parse(
        readFileSync(
          new URL("./owner-pg-source-fixtures.json", import.meta.url),
          "utf8",
        ),
      );
      writeFileSync(
        file,
        name.startsWith("node_modules/")
          ? fixtures[name.slice("node_modules/".length)]
          : `// synthetic ${name}\n`,
      );
    }
    process.env.DECODER_QUALIFICATION_ROOT = root;
    process.env.DECODER_QUALIFICATION_RESULT = path.join(
      run,
      "vitest-results.json",
    );
    const module = Buffer.from("export default {};\n");
    const upload = async (option = "") => {
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          main_module: option === "entry" ? "other.js" : "data-api.js",
          compatibility_date: "2026-06-06",
          compatibility_flags: ["nodejs_compat"],
        }),
      );
      form.set(
        "data-api.js",
        new Blob([module], {
          type:
            option === "type" ? "text/plain" : "application/javascript+module",
        }),
        "data-api.js",
      );
      if (option !== "missing-map") {
        const sources = sourceNames.filter(
          (name) =>
            name !== "wrangler.data.jsonc" &&
            !(
              option === "missing-pg" &&
              name === "node_modules/pg/lib/client.js"
            ),
        );
        form.set(
          "data-api.js.map",
          new Blob(
            [
              JSON.stringify({
                version: 3,
                sources,
                sourcesContent: sources.map((name) =>
                  option === "wrong-source"
                    ? "changed"
                    : readFileSync(path.join(root, name), "utf8"),
                ),
                mappings: "",
              }),
            ],
            { type: "application/source-map" },
          ),
          "data-api.js.map",
        );
      }
      return new Uint8Array(
        await new Request("https://synthetic.invalid", {
          method: "POST",
          body: form,
        }).arrayBuffer(),
      );
    };
    preserveOwnerBuild(
      "queue",
      "data-api.js",
      [{ name: "data-api.js", type: "ESModule", bytes: module }],
      [],
      { kind: "wrangler-upload", bytes: await upload() },
    );
    const manifest = () =>
      JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    const save = (value: unknown) =>
      writeFileSync(
        path.join(directory, "manifest.json"),
        JSON.stringify(value),
      );
    const replaceAssociation = (body: Uint8Array) => {
      writeFileSync(path.join(directory, "association.bin"), body);
      const row = manifest();
      row.association.bytes = body.byteLength;
      row.association.sha256 = hash(body);
      save(row);
    };
    await action({
      root,
      directory,
      manifest,
      save,
      replaceAssociation,
      upload,
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
test("valid genuine multipart association binds module bytes and exact installed source contents", async () =>
  fixture(async ({ directory, root }) => {
    const proof = await validateOwnerBuild(
      directory,
      "queue",
      root,
      "a".repeat(64),
    );
    assert.equal(proof.modules.length, 1);
    assert.equal(proof.runtimeSha256, "a".repeat(64));
  }));
for (const option of [
  "entry",
  "type",
  "missing-map",
  "missing-pg",
  "wrong-source",
])
  test(`rejects multipart ${option}`, async () =>
    fixture(async ({ directory, root, upload, replaceAssociation }) => {
      replaceAssociation(await upload(option));
      await assert.rejects(() =>
        validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
      );
    }));
test("rejects unrelated module with self-consistent invented hash and size", async () =>
  fixture(async ({ directory, root, manifest, save }) => {
    const bytes = Buffer.from("unrelated");
    writeFileSync(path.join(directory, "module-000.bin"), bytes);
    const row = manifest();
    row.modules[0].bytes = bytes.length;
    row.modules[0].sha256 = hash(bytes);
    save(row);
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects wrong entry despite otherwise valid hashes", async () =>
  fixture(async ({ directory, root, manifest, save }) => {
    const row = manifest();
    row.entry = "other.js";
    save(row);
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects unexpected evidence file", async () =>
  fixture(async ({ directory, root }) => {
    writeFileSync(path.join(directory, "extra"), "x");
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects symlinked module leaf", async () =>
  fixture(async ({ directory, root }) => {
    renameSync(
      path.join(directory, "module-000.bin"),
      path.join(directory, "saved"),
    );
    symlinkSync("saved", path.join(directory, "module-000.bin"));
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects symlinked project source parent", async () =>
  fixture(async ({ directory, root }) => {
    const escaped = path.join(path.dirname(root), "escaped");
    renameSync(path.join(root, "src"), escaped);
    symlinkSync(escaped, path.join(root, "src"));
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects dependency parent escaping the exact dependency root", async () =>
  fixture(async ({ directory, root }) => {
    const escaped = path.join(path.dirname(root), "escaped");
    renameSync(path.join(root, "node_modules/pg"), escaped);
    symlinkSync(escaped, path.join(root, "node_modules/pg"));
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects source traversal before reading it", async () =>
  fixture(async ({ directory, root, manifest, save }) => {
    const row = manifest();
    row.sources.push({ path: "../outside", sha256: "a".repeat(64) });
    save(row);
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects wrong owner", async () =>
  fixture(async ({ directory, root }) => {
    await assert.rejects(() =>
      validateOwnerBuild(directory, "raw", root, "a".repeat(64)),
    );
  }));
test("rejects invented source hash", async () =>
  fixture(async ({ directory, root, manifest, save }) => {
    const row = manifest();
    row.sources[0].sha256 = "0".repeat(64);
    save(row);
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects missing association manifest", async () =>
  fixture(async ({ directory, root, manifest, save }) => {
    const row = manifest();
    delete row.association;
    save(row);
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
test("rejects non-regular evidence entry", async () =>
  fixture(async ({ directory, root }) => {
    mkdirSync(path.join(directory, "unexpected-directory"));
    await assert.rejects(() =>
      validateOwnerBuild(directory, "queue", root, "a".repeat(64)),
    );
  }));
