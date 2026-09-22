import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import {
  applyRegistrySyncToD1,
  REGISTRY_D1_TABLES,
} from "../src/registry-sync-d1.ts";
import type { RegistrySyncPayload } from "../src/registry-sync-neon.ts";
import worker from "../workers/registry-sync-api.ts";
import { registrySyncEnv } from "./helpers/worker-env.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let nextId = 0;
const stamp = 1790100000000;
const empty = (): RegistrySyncPayload => ({
  providers: [],
  subnets: [],
  surfaces: [],
  pruneSurfaces: [],
  deleteSubnets: [],
});
const subnet = (netuid = 7) => ({
  netuid,
  slug: `subnet-${netuid}`,
  name: "Subnet",
  overlay: { name: "Subnet" },
  source_commit: "source",
});
const surface = (url = "https://example.com", version = 1) => ({
  subnet_netuid: 7,
  surface_key: url,
  kind: "rest",
  url,
  overlay: { version },
  source_commit: `version-${version}`,
});
const apply = (payload: Partial<RegistrySyncPayload>) =>
  applyRegistrySyncToD1(
    createD1Store(db),
    { ...empty(), ...payload },
    { newId: () => `id-${nextId++}`, now: () => stamp },
  );
const history = async () =>
  (
    await db
      .prepare(
        "SELECT surface_id,action,overlay,source_commit FROM surface_history ORDER BY id",
      )
      .all()
  ).results;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const s of readFileSync(
    new URL("../migrations/d1/0013_registry_self_health.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (s.trim()) await db.prepare(s).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const t of REGISTRY_D1_TABLES)
    await db.prepare(`DELETE FROM ${t}`).run();
  nextId = 0;
});
test("bulk sync preserves IDs, unchanged provenance, and exact summary counts", async () => {
  const p = {
    providers: [{ id: "p", overlay: { v: 1 }, source_commit: "first" }],
    subnets: [subnet()],
    surfaces: [
      {
        ...surface(),
        provider_id: "p",
        authority: "official",
        review_state: "reviewed",
        probe_eligible: true,
        public_safe: false,
      },
    ],
  };
  assert.deepEqual(await apply(p), {
    providers_written: 1,
    subnets_written: 1,
    surfaces_written: 1,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
  assert.equal(
    (
      await apply({
        ...p,
        providers: [{ ...p.providers[0], source_commit: "ignored" }],
        surfaces: [{ ...p.surfaces[0], source_commit: "ignored" }],
      })
    ).surfaces_written,
    0,
  );
  assert.equal(
    await db
      .prepare("SELECT source_commit FROM providers WHERE id='p'")
      .first("source_commit"),
    "first",
  );
  assert.equal((await history()).length, 1);
  const old = await db.prepare("SELECT * FROM surfaces").first();
  assert.equal(old?.probe_eligible, 1);
  assert.equal(old?.public_safe, 0);
  await apply({ surfaces: [surface(undefined, 2)] });
  const current = await db.prepare("SELECT * FROM surfaces").first();
  assert.equal(current?.id, old?.id);
  assert.equal(current?.authority, "community");
  assert.equal(current?.public_safe, 1);
  assert.deepEqual(
    (await history()).map((r) => r.action),
    ["insert", "update"],
  );
});
test("duplicate keys and reversions retain every logical change in payload order", async () => {
  const rows = [
    surface(undefined, 1),
    surface(undefined, 1),
    surface(undefined, 2),
    surface(undefined, 1),
  ];
  assert.equal((await apply({ surfaces: rows })).surfaces_written, 3);
  assert.deepEqual(
    (await history()).map((r) => [r.surface_id, r.action, r.overlay]),
    [
      ["id-0", "insert", '{"version":1}'],
      ["id-0", "update", '{"version":2}'],
      ["id-0", "update", '{"version":1}'],
    ],
  );
  assert.equal(
    (await apply({ surfaces: [surface(undefined, 3), surface(undefined, 1)] }))
      .surfaces_written,
    2,
  );
  assert.equal(await db.prepare("SELECT id FROM surfaces").first("id"), "id-0");
  assert.equal(
    await db
      .prepare("SELECT source_commit FROM surfaces")
      .first("source_commit"),
    "version-1",
  );
});
test("community prune and subnet deletion record the exact deleted rows and first matching source", async () => {
  await apply({
    subnets: [subnet(), subnet(8)],
    surfaces: [
      surface("keep"),
      surface("old"),
      { ...surface("official"), authority: "official" },
      { ...surface("other"), subnet_netuid: 8 },
    ],
  });
  const result = await apply({
    pruneSurfaces: [
      {
        subnet_netuid: 7,
        authority_scope: "community",
        current_surfaces: [{ kind: "rest", url: "keep" }, null, {}],
        source_commit: "prune-first",
      },
      { subnet_netuid: 7, current_surfaces: [], source_commit: "prune-next" },
    ],
    deleteSubnets: [{ netuid: 8, source_commit: "delete" }],
  });
  assert.equal(result.surfaces_deleted, 4);
  assert.equal(result.subnets_deleted, 1);
  const deleted = (await history()).filter((r) => r.action === "delete");
  assert.equal(
    deleted.find((r) => r.surface_id === "id-1")?.source_commit,
    "prune-first",
  );
  assert.equal(
    deleted.find((r) => r.surface_id === "id-0")?.source_commit,
    "prune-next",
  );
  assert.equal(
    deleted.find((r) => r.surface_id === "id-2")?.source_commit,
    "prune-next",
  );
  assert.equal(
    deleted.find((r) => r.surface_id === "id-3")?.source_commit,
    "delete",
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM surfaces").first("n"),
    0,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM subnets").first("n"),
    1,
  );
});
test("a rewritten subnet is protected from deletion and malformed rows remain skipped", async () => {
  await apply({ subnets: [subnet()], surfaces: [surface()] });
  const result = await apply({
    providers: [{}, { id: "bad" }, { id: "bad", overlay: {} }],
    subnets: [
      ...["netuid", "slug", "name", "overlay", "source_commit"].map((key) =>
        Object.fromEntries(Object.entries(subnet()).filter(([k]) => k !== key)),
      ),
      { ...subnet(), source: "official" },
    ],
    surfaces: [
      ...[
        "subnet_netuid",
        "surface_key",
        "kind",
        "url",
        "overlay",
        "source_commit",
      ].map((key) =>
        Object.fromEntries(
          Object.entries(surface()).filter(([k]) => k !== key),
        ),
      ),
    ],
    pruneSurfaces: [
      {},
      { subnet_netuid: 7 },
      { subnet_netuid: 7, current_surfaces: [] },
    ],
    deleteSubnets: [{}, { netuid: 7 }, { netuid: 7, source_commit: "delete" }],
  });
  assert.equal(result.subnets_deleted, 0);
  assert.equal(result.surfaces_deleted, 0);
  assert.equal(result.surfaces_written, 0);
  assert.equal(
    await db
      .prepare("SELECT source FROM subnets WHERE netuid=7")
      .first("source"),
    "official",
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM surfaces").first("n"),
    1,
  );
});
test("an empty retry without dependency overrides is a no-op", async () => {
  assert.deepEqual(await applyRegistrySyncToD1(createD1Store(db), empty()), {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
});
test("the full capture rolls back when a later history write fails", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_history BEFORE INSERT ON surface_history WHEN NEW.action='insert' BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  try {
    await assert.rejects(
      () =>
        apply({
          subnets: [subnet()],
          providers: [{ id: "p", overlay: {}, source_commit: "x" }],
          surfaces: [surface()],
        }),
      /injected/,
    );
    for (const t of REGISTRY_D1_TABLES)
      assert.equal(
        await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first("n"),
        0,
      );
  } finally {
    await db.prepare("DROP TRIGGER reject_history").run();
  }
});
test("multiple bounded chunks preserve one ID across thousands of duplicate mutations", async () => {
  const result = await apply({
    surfaces: Array.from({ length: 5000 }, (_, i) => surface(undefined, i)),
  });
  assert.equal(result.surfaces_written, 5000);
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM surfaces").first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare("SELECT COUNT(DISTINCT surface_id) n FROM surface_history")
      .first("n"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT overlay FROM surfaces").first("overlay"),
    '{"version":4999}',
  );
});
test("large payloads flush before the byte ceiling, and oversized rows or transactions fail before writing", async () => {
  await apply({
    providers: [0, 1, 2].map((i) => ({
      id: String(i),
      overlay: { value: "x".repeat(200000) },
      source_commit: "s",
    })),
  });
  await assert.rejects(
    () =>
      apply({
        surfaces: [{ ...surface(), overlay: { value: "x".repeat(524288) } }],
      }),
    /payload budget/,
  );
  await assert.rejects(
    () =>
      apply({
        providers: Array.from({ length: 90001 }, (_, i) => ({
          id: String(i),
          overlay: { v: 2 },
          source_commit: "s",
        })),
      }),
    /statement budget/,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM providers").first("n"),
    3,
  );
});
test("authenticated sync selects native D1 and identifies the actual durable store", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/api/v1/internal/registry-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-registry-sync-token": "fixture",
      },
      body: JSON.stringify({ subnets: [subnet()], surfaces: [surface()] }),
    }),
    registrySyncEnv({
      D1_STATE: db,
      D1_STATE_TABLES: REGISTRY_D1_TABLES.join(","),
      HYPERDRIVE: undefined,
      REGISTRY_SYNC_SECRET: "fixture",
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json<{
    store: string;
    surfaces_written: number;
  }>();
  assert.equal(body.store, "d1");
  assert.equal(body.surfaces_written, 1);
});
