// Executes applyRegistrySyncToD1's statements against a REAL SQLite database
// built from the real schema (migrations/d1/0001_registry.sql).
//
// WHY THIS EXISTS ALONGSIDE registry-sync-api.test.ts. That suite uses a D1
// fake, which records statement text and binds but never PARSES them -- so a
// syntax error, a wrong column name, a violated CHECK, or a foreign key that
// does not hold would pass every assertion there. The same lesson the chain
// tier learned from mocked postgres tests applies verbatim here, and it matters
// more in this migration than usual: SQLite silently returns NULL for a bad
// json_extract path rather than erroring, so a wrong path reads as "no value"
// instead of "bad query".
//
// node:sqlite is Node's built-in binding, so this adds no dependency. The
// adapter below implements exactly the slice of the D1 API the write path uses
// (prepare/bind/all and batch), with batch running inside a real transaction so
// the all-or-nothing claim is actually exercised rather than asserted.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import { applyRegistrySyncToD1 } from "../workers/registry-sync-api.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0001_registry.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

// A minimal, faithful D1 adapter. `batch` wraps the statements in a real
// transaction: that is what makes "one batch, all-or-nothing" a tested property
// rather than a comment.
function d1(database: InstanceType<typeof DatabaseSync>) {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return {
                results: database.prepare(sql).all(...(values as never[])),
              };
            },
            run() {
              database.prepare(sql).run(...(values as never[]));
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      database.exec("BEGIN");
      try {
        for (const s of statements) (s as { run(): void }).run();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements;
    },
  };
}

const empty = {
  providers: [],
  subnets: [],
  surfaces: [],
  pruneSurfaces: [],
  deleteSubnets: [],
};

const provider = {
  id: "acme",
  overlay: { id: "acme", name: "Acme" },
  source_commit: "abc123",
};
const subnet = {
  netuid: 8,
  slug: "taoshi",
  name: "Taoshi",
  source: "community",
  overlay: { netuid: 8, name: "Taoshi" },
  source_commit: "abc123",
};
const surface = (over: Record<string, unknown> = {}) => ({
  subnet_netuid: 8,
  provider_id: "acme",
  surface_key: "sn-8-docs",
  kind: "docs",
  url: "https://example.com/docs",
  overlay: { kind: "docs" },
  source_commit: "abc123",
  ...over,
});

const rows = (sql: string) =>
  db.prepare(sql).all() as Record<string, unknown>[];
const count = (table: string) =>
  (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
});

// The single most valuable assertion in this file: the real schema accepts the
// real statements. Everything the fake cannot check is checked by this passing.
test("providers and subnets upsert against the real schema", async () => {
  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [provider],
    subnets: [subnet],
  });
  assert.equal(summary.providers_written, 1);
  assert.equal(summary.subnets_written, 1);
  assert.equal(count("providers"), 1);
  assert.equal(count("subnets"), 1);

  const [row] = rows("SELECT overlay, updated_at FROM providers");
  // jsonb -> TEXT, still readable as JSON by SQLite itself.
  assert.equal(
    (
      db
        .prepare("SELECT json_extract(overlay,'$.name') v FROM providers")
        .get() as { v: string }
    ).v,
    "Acme",
  );
  // timestamptz -> epoch MILLIseconds, not seconds. A seconds value would still
  // insert cleanly and only be wrong much later, so it is pinned here.
  const updatedAt = Number(row.updated_at);
  assert.ok(
    updatedAt > 1_700_000_000_000,
    `epoch-ms expected, got ${updatedAt}`,
  );
});

test("a re-sync with an unchanged provider overlay leaves the row untouched", async () => {
  await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [provider],
  });
  const before = rows("SELECT updated_at, source_commit FROM providers")[0];
  await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [{ ...provider, source_commit: "zzz999" }],
  });
  const after = rows("SELECT updated_at, source_commit FROM providers")[0];
  // The DO UPDATE ... WHERE providers.overlay IS NOT excluded.overlay guard --
  // SQLite's IS NOT standing in for Postgres' IS DISTINCT FROM. Unchanged
  // overlay means the row is not rewritten, so the commit does NOT advance.
  assert.equal(after.source_commit, before.source_commit);
});

test("a changed provider overlay does rewrite the row", async () => {
  await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [provider],
  });
  await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [
      {
        ...provider,
        overlay: { id: "acme", name: "Acme Corp" },
        source_commit: "zzz999",
      },
    ],
  });
  assert.equal(
    rows("SELECT source_commit FROM providers")[0].source_commit,
    "zzz999",
  );
});

test("a surface insert satisfies both foreign keys and the boolean CHECKs", async () => {
  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [provider],
    subnets: [subnet],
    surfaces: [surface({ probe_eligible: true, public_safe: false })],
  });
  assert.equal(summary.surfaces_written, 1);
  const [row] = rows("SELECT id, probe_eligible, public_safe FROM surfaces");
  assert.equal(row.probe_eligible, 1);
  assert.equal(row.public_safe, 0);
  // No DB default for surfaces.id -- the caller supplied a real UUID.
  assert.match(
    String(row.id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(
    (
      db.prepare("SELECT action FROM surface_history").get() as {
        action: string;
      }
    ).action,
    "insert",
  );
});

// The replacement for Postgres' RETURNING (xmax = 0): a second sync of a CHANGED
// surface must update in place and record "update", not insert a duplicate.
test("re-syncing a changed surface updates in place and records an update", async () => {
  const seed = { ...empty, providers: [provider], subnets: [subnet] };
  await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [surface()],
  });
  const originalId = rows("SELECT id FROM surfaces")[0].id;

  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [surface({ overlay: { kind: "docs", note: "changed" } })],
  });
  assert.equal(summary.surfaces_written, 1);
  assert.equal(count("surfaces"), 1, "must not duplicate on the unique key");
  // The row keeps its original id -- the UPDATE branch must not re-key it,
  // because surface_history rows point at that id.
  assert.equal(rows("SELECT id FROM surfaces")[0].id, originalId);
  const actions = rows("SELECT action FROM surface_history ORDER BY id").map(
    (r) => r.action,
  );
  assert.deepEqual(actions, ["insert", "update"]);
});

test("re-syncing an unchanged surface writes nothing at all", async () => {
  const seed = { ...empty, providers: [provider], subnets: [subnet] };
  await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [surface()],
  });
  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [surface()],
  });
  assert.equal(summary.surfaces_written, 0);
  assert.equal(count("surface_history"), 1, "no second history row");
});

// The json_each keep-list is the statement most likely to be silently wrong,
// because a bad json_extract path returns NULL instead of erroring -- which here
// would mean "nothing matches the keep list" and delete every surface.
test("prune deletes only surfaces absent from the keep list", async () => {
  const seed = { ...empty, providers: [provider], subnets: [subnet] };
  await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [
      surface(),
      surface({
        surface_key: "sn-8-api",
        kind: "subnet-api",
        url: "https://example.com/api",
      }),
    ],
  });
  assert.equal(count("surfaces"), 2);

  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    pruneSurfaces: [
      {
        subnet_netuid: 8,
        current_surfaces: [{ kind: "docs", url: "https://example.com/docs" }],
        source_commit: "def456",
      },
    ],
  });
  assert.equal(summary.surfaces_deleted, 1);
  const remaining = rows("SELECT kind FROM surfaces");
  assert.deepEqual(
    remaining.map((r) => r.kind),
    ["docs"],
    "the kept surface survived and the other went",
  );
  const del = db
    .prepare(
      "SELECT surface_id, action FROM surface_history WHERE action='delete'",
    )
    .get() as { surface_id: string; action: string };
  assert.ok(del.surface_id, "delete history carries the surface id");
});

test("prune with authority_scope 'community' spares non-community rows", async () => {
  const seed = { ...empty, providers: [provider], subnets: [subnet] };
  await applyRegistrySyncToD1(d1(db) as never, {
    ...seed,
    surfaces: [
      surface({ authority: "community" }),
      surface({
        surface_key: "sn-8-observed",
        kind: "subnet-api",
        url: "https://example.com/observed",
        authority: "registry-observed",
      }),
    ],
  });
  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    pruneSurfaces: [
      {
        subnet_netuid: 8,
        current_surfaces: [],
        source_commit: "def456",
        authority_scope: "community",
      },
    ],
  });
  assert.equal(summary.surfaces_deleted, 1);
  assert.deepEqual(
    rows("SELECT authority FROM surfaces").map((r) => r.authority),
    ["registry-observed"],
  );
});

// The FK is ON DELETE RESTRICT, so subnets must go only after their surfaces --
// ordering the batch wrong would raise a constraint error here and nowhere else.
test("deleting a subnet removes its surfaces first and satisfies the RESTRICT foreign key", async () => {
  await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    providers: [provider],
    subnets: [subnet],
    surfaces: [surface()],
  });
  const summary = await applyRegistrySyncToD1(d1(db) as never, {
    ...empty,
    deleteSubnets: [{ netuid: 8, source_commit: "def456" }],
  });
  assert.equal(summary.subnets_deleted, 1);
  assert.equal(summary.surfaces_deleted, 1);
  assert.equal(count("subnets"), 0);
  assert.equal(count("surfaces"), 0);
  // History outlives the surface it describes -- surface_history deliberately
  // has no foreign key, which this proves rather than assumes.
  assert.equal(count("surface_history"), 2);
});

test("a failing batch rolls back entirely, leaving no partial sync", async () => {
  const seed = { ...empty, providers: [provider], subnets: [subnet] };
  await applyRegistrySyncToD1(d1(db) as never, seed);
  const before = count("providers");

  const exploding = d1(db);
  const original = exploding.batch.bind(exploding);
  exploding.batch = async (statements: unknown[]) =>
    original([
      ...statements,
      {
        run: () => {
          throw new Error("boom");
        },
      },
    ]);

  await assert.rejects(
    applyRegistrySyncToD1(exploding as never, {
      ...empty,
      providers: [{ id: "new-one", overlay: { a: 1 }, source_commit: "x" }],
    }),
  );
  assert.equal(
    count("providers"),
    before,
    "the good statement rolled back too",
  );
});
