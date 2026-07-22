// Unit tests for scripts/apply-migrations.ts's pure, DB-independent pieces
// (#7230): CLI argument parsing, migration file loading/ordering, and the
// idempotency guard that decides which migrations run on a given pass.
// Importing the module must NOT open a DB connection (the CLI entrypoint is
// import.meta.url-guarded), so these run without a live Postgres.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
  loadMigrationFiles,
  parseArgs,
  pendingMigrations,
} from "../scripts/apply-migrations.ts";

describe("parseArgs", () => {
  const savedDbUrl = process.env.DATABASE_URL;
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  test("defaults dryRun to false and databaseUrl to $DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://env-default";
    const opts = parseArgs([]);
    assert.equal(opts.dryRun, false);
    assert.equal(opts.databaseUrl, "postgres://env-default");
    assert.equal(opts.bootstrapThrough, undefined);
  });

  test("parses --dry-run", () => {
    assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  });

  test("--database-url overrides the env default", () => {
    process.env.DATABASE_URL = "postgres://env-default";
    assert.equal(
      parseArgs(["--database-url", "postgres://explicit"]).databaseUrl,
      "postgres://explicit",
    );
  });

  test("parses --bootstrap-through with its value", () => {
    assert.equal(
      parseArgs(["--bootstrap-through", "0007"]).bootstrapThrough,
      "0007",
    );
  });

  test("parses a combination of flags in any order", () => {
    const opts = parseArgs([
      "--dry-run",
      "--bootstrap-through",
      "0012",
      "--database-url",
      "postgres://x",
    ]);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.bootstrapThrough, "0012");
    assert.equal(opts.databaseUrl, "postgres://x");
  });

  test("throws on an unrecognized argument rather than guessing", () => {
    assert.throws(() => parseArgs(["--wat"]), /unrecognized argument: --wat/);
  });
});

describe("pendingMigrations (idempotency guard)", () => {
  const migrations = [
    { version: "0001", name: "0001_init.sql" },
    { version: "0002", name: "0002_add.sql" },
    { version: "0003", name: "0003_more.sql" },
  ];

  test("returns every migration when none are applied yet", () => {
    assert.deepEqual(
      pendingMigrations(migrations, []).map((m) => m.version),
      ["0001", "0002", "0003"],
    );
  });

  test("returns [] when every version is already applied (a re-run is a no-op)", () => {
    assert.deepEqual(
      pendingMigrations(migrations, ["0001", "0002", "0003"]),
      [],
    );
  });

  test("returns only the un-applied versions, preserving load order", () => {
    const pending = pendingMigrations(migrations, ["0001"]);
    assert.deepEqual(
      pending.map((m) => m.version),
      ["0002", "0003"],
    );
  });

  test("ignores recorded versions that no longer exist as files (extra applied rows)", () => {
    assert.deepEqual(
      pendingMigrations(migrations, ["0001", "0002", "0003", "0099"]),
      [],
    );
  });
});

describe("loadMigrationFiles (ordering + filtering)", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("returns .sql files sorted by name, each {version, name, sql}, ignoring non-sql files", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "apply-migrations-"));
    // Written out of order, plus a non-.sql file that must be ignored.
    await writeFile(path.join(dir, "0002_b.sql"), "SELECT 2;");
    await writeFile(path.join(dir, "0001_a.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "0003_c.sql"), "SELECT 3;");
    await writeFile(path.join(dir, "README.md"), "not a migration");

    const migrations = await loadMigrationFiles(dir);

    assert.deepEqual(
      migrations.map((m) => m.name),
      ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
    );
    assert.deepEqual(
      migrations.map((m) => m.version),
      ["0001", "0002", "0003"],
    );
    assert.equal(migrations[0].sql, "SELECT 1;");
    // The .md is filtered out; only the three .sql files load.
    assert.equal(migrations.length, 3);
  });

  test("returns [] for a directory with no .sql files", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "apply-migrations-empty-"));
    await writeFile(path.join(dir, ".gitkeep"), "");
    assert.deepEqual(await loadMigrationFiles(dir), []);
  });
});
