import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgArchiveCatalog } from "../src/archive-catalog-pg.ts";
import { createFilesystemArchiveContent } from "../src/archive-content-fs.ts";
import {
  archiveObjectStore,
  withArchiveObjects,
} from "../src/archive-object-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime;
let ownsSchema = false;
let ownsTable = false;
let directory: string;
const hash = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
async function body(
  store: ReturnType<typeof archiveObjectStore>,
  key: string,
  options?: R2GetOptions,
) {
  const result = await store.get(key, options);
  assert.ok(result && "body" in result);
  return result;
}

describe(
  "PostgreSQL archive catalog and immutable filesystem content",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownsSchema =
        (await control.query("SELECT to_regnamespace('app') AS existing"))
          .rows[0].existing === null;
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0006_generated_artifacts.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      ownsTable = true;
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
      directory = await mkdtemp(join(tmpdir(), "metagraphed-archive-pg18-"));
    });
    beforeEach(async () => {
      await control.query("TRUNCATE app.generated_artifacts");
    });
    after(async () => {
      try {
        await runtime?.close();
        if (ownsTable)
          await control.query("DROP TABLE app.generated_artifacts");
        if (ownsSchema) await control.query("DROP SCHEMA app");
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        await control.end();
      }
    });

    it("uses the normal archive writer and admits exactly one competing conditional replacement", async () => {
      const store = archiveObjectStore({
        ARCHIVE_CATALOG_STORE: createPgArchiveCatalog(runtime),
      });
      const old = await store.put("fixture/conditional", "before");
      const result = await Promise.all([
        store.put("fixture/conditional", "candidate-a", {
          onlyIf: { etagMatches: old.etag },
        }),
        store.put("fixture/conditional", "candidate-b", {
          onlyIf: { etagMatches: old.etag },
        }),
      ]);
      assert.equal(result.filter(Boolean).length, 1);
      const index = result.findIndex(Boolean);
      assert.equal(
        await (await body(store, "fixture/conditional")).text(),
        `candidate-${index ? "b" : "a"}`,
      );
      assert.equal(
        await store.put("fixture/missing", "no", {
          onlyIf: { etagMatches: old.etag },
        }),
        null,
      );
    });

    it("preserves compressed chunks, metadata, ranges and tombstones through the shared pool", async () => {
      const catalog = createPgArchiveCatalog(runtime);
      const store = archiveObjectStore({ ARCHIVE_CATALOG_STORE: catalog });
      const value = randomBytes(50000).toString("base64") + "\0終わり";
      await store.put("fixture/large", value);
      assert.equal(await (await body(store, "fixture/large")).text(), value);
      assert.ok(
        (
          await catalog.read([
            "archive-object/v1/metagraphed-artifacts/fixture/large",
          ])
        )[0].payload.includes('"d1"'),
      );
      assert.equal(
        await (
          await body(store, "fixture/large", {
            range: { offset: 10, length: 8 },
          })
        ).text(),
        value.slice(10, 18),
      );
      await catalog.insert(
        "archive-object/v1/metagraphed-artifacts/gone",
        JSON.stringify({
          version: 1,
          bucket: "metagraphed-artifacts",
          key: "gone",
          deleted: true,
        }),
      );
      assert.equal(await store.get("gone"), null);
      await control.query(
        "UPDATE app.generated_artifacts SET payload=$1 WHERE key LIKE 'archive-payload/%'",
        [JSON.stringify({ data: "bad" })],
      );
      await assert.rejects(
        (await body(store, "fixture/large")).text(),
        /chunk length differs/,
      );
    });

    it("reads imported immutable content through ordinary whole and partial object paths", async () => {
      const catalog = createPgArchiveCatalog(runtime);
      const content = await createFilesystemArchiveContent({
        directory,
        maxConcurrentOperations: 2,
        maxChunkBytes: 524288,
      });
      const bytes = Buffer.from("immutable fixture content"),
        sha256 = hash(bytes),
        etag = hash(bytes, "md5");
      await content.publish(sha256, bytes, new AbortController().signal);
      const key = "fixture/imported",
        part = `archive-content/v1/${sha256}`;
      await catalog.insert(
        `archive-object/v1/metagraphed-artifacts/${key}`,
        JSON.stringify({
          version: 1,
          bucket: "metagraphed-artifacts",
          key,
          bytes: bytes.length,
          etag,
          sha256,
          modified: "2026-01-01T00:00:00Z",
          metadata: {
            ContentType: "application/json",
            Metadata: { imported: "true" },
          },
          body: { parts: [{ key: part, bytes: bytes.length, etag, sha256 }] },
        }),
      );
      await catalog.insert(
        `native-object/v1/metagraphed-artifacts/${part}`,
        JSON.stringify({
          version: 1,
          bucket: "metagraphed-artifacts",
          key: part,
          bytes: bytes.length,
          etag,
          sha256,
          partition: "a",
          chunks: [{ bytes: bytes.length, sha256 }],
        }),
      );
      const env = withArchiveObjects({
        ARCHIVE_OBJECT_STORAGE: "native",
        ARCHIVE_CATALOG_STORE: catalog,
        ARCHIVE_CONTENT_STORE: content,
      });
      const store = (
        env as typeof env & {
          METAGRAPH_ARCHIVE: ReturnType<typeof archiveObjectStore>;
        }
      ).METAGRAPH_ARCHIVE;
      assert.equal(await (await body(store, key)).text(), bytes.toString());
      assert.equal(
        await (
          await body(store, key, { range: { offset: 10, length: 7 } })
        ).text(),
        "fixture",
      );
      assert.equal(
        (await store.head(key))?.httpMetadata?.contentType,
        "application/json",
      );
      assert.deepEqual((await store.head(key))?.customMetadata, {
        imported: "true",
      });
      const file = join(directory, `${sha256}.mgpack`);
      await chmod(file, 0o600);
      await writeFile(file, Buffer.alloc(bytes.length));
      await assert.rejects((await body(store, key)).text(), /checksum/);
      await rm(file);
      await assert.rejects((await body(store, key)).text(), /ENOENT/);
    });
  },
);
