// The surface audit trail (src/surface-history.ts, #9612).
//
// The load-bearing property is IDENTITY SURVIVES A MISSING COLUMN.
//
// The registry-sync upsert path omitted `surface_id` from its INSERT column
// list, so 8,831 of the table's 8,892 rows carried a NULL and only the 61
// deletes recorded one — an audit trail that could say a subnet changed and not
// which of its surfaces. The id was written the whole time inside the `overlay`
// blob, so migration 0024 backfilled the column and the writer now records it.
//
// This reader still coalesces column -> overlay, and that is deliberately not
// belt-and-braces: migrations here are applied BY HAND, so a fresh environment,
// a preview database, or a restore from before 0024 has the nulls back. The
// tests below therefore exercise both shapes explicitly — a row with the column
// set, and a row with only the overlay — because in production both exist.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, test, vi } from "vitest";

// `surface_history` is declared Neon's (#10179), so this reader is reached
// through readStore -> `new Client({ connectionString })`, which no caller can
// inject into: the route, the resolver and the MCP handler each build their own
// store from `env`. Mocking the `pg` module is the seam; see
// tests/helpers/pg-mock.ts for why it is a module mock rather than a
// production export, and why the controller has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  SURFACE_HISTORY_ACTIONS,
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
  buildSurfaceHistory,
  loadSurfaceHistory,
} from "../src/surface-history.ts";
import { readStore } from "../src/read-store.ts";
import { SURFACE_HISTORY_TABLES } from "../src/read-store-tables.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";

/**
 * The real NEON DDL, applied verbatim (#10328).
 *
 * `overlay` is TEXT here, which is the point: the loader reads it as
 * `overlay::jsonb ->> 'key'`, and the SQLite path deleted that cast and then
 * ASSUMED SQLite's `->>` performed the identical extraction. It is a
 * reasonable assumption and it was never tested against the engine that
 * actually runs it -- casting TEXT to jsonb is exactly the kind of operation
 * whose failure modes (invalid JSON, a non-object, a null) differ between
 * engines. Running it on Postgres turns the assumption into a result.
 */
const MIGRATIONS = ["migrations/neon/0005_remaining_d1_tables.sql"].map((f) =>
  fs.readFileSync(path.join(process.cwd(), f), "utf8"),
);

const NETUID = 7;
const T = 1_785_642_908_000;

let db: PGlite;

/** The env a served request gets: Hyperdrive bound and `surface_history`
 * declared Neon's, which is what makes readStore hand back a store at all. */
const env = () => pgMockEnv(SURFACE_HISTORY_TABLES) as unknown as Env;

/**
 * The store the route, the resolver and the MCP handler each build for
 * themselves, so a direct loader call runs down the same path a served request
 * does -- including the `?` -> `$n` rewrite, which is the difference that made
 * six routes serve zero rows in #9821.
 *
 * The cast mirrors the call sites: readStore is typed for its own D1-shaped
 * interface and the loader declares a narrower one of its own.
 */
const store = () =>
  readStore(env(), SURFACE_HISTORY_TABLES) as never as unknown as Parameters<
    typeof loadSurfaceHistory
  >[0];

async function change({
  surfaceId = null,
  overlayId = "surf-1",
  action = "update",
  netuid = NETUID,
  at = T,
  kind = "subnet-api",
  url = "https://api.example.com/v1",
  name = "Example API",
  commit = "c7d264b4fa93d414ff9dfc54c9989af816736cd1",
}: Partial<{
  surfaceId: string | null;
  overlayId: string | null;
  action: string;
  netuid: number;
  at: number;
  kind: string;
  url: string;
  name: string;
  commit: string;
}> = {}) {
  const overlay: Row = { kind, url, name };
  if (overlayId !== null) overlay.id = overlayId;
  await db.query(
    `INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [surfaceId, netuid, action, JSON.stringify(overlay), commit, at] as never[],
  );
}

// ONE instance for the file, TRUNCATE between tests.
beforeAll(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
});

beforeEach(async () => {
  // RE-APPLY, not just TRUNCATE. One instance serves the whole file, and a
  // test below DROPS the table on purpose to reach the failed-read path -- so
  // "empty the table" is not enough to undo it. The migrations are all
  // `IF NOT EXISTS`, so this is a no-op on every tick except that one.
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.exec("TRUNCATE surface_history");
  // The double answers from the real registry table rather than canned rows,
  // because half of what is asserted below -- the COALESCE, the ordering, the
  // LIMIT -- is a fact about what an engine did, not about the statement text.
  // Handed over VERBATIM now, `overlay::jsonb ->> 'k'` included, so the jsonb
  // extraction is judged by Postgres rather than by SQLite standing in for it.
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values as never[])).rows;
});

describe("identity survives a missing surface_id column", () => {
  test("recovers the id from the overlay when the column is null", async () => {
    // The shape 8,831 of 8,892 production rows had before 0024, and the shape a
    // pre-migration database still has.
    await change({ surfaceId: null, overlayId: "surf-abc" });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.equal(rows?.[0].surface_id, "surf-abc");
  });

  test("prefers the column when it is set", async () => {
    // A delete row, and every row after the writer fix.
    await change({ surfaceId: "surf-column", overlayId: "surf-overlay" });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.equal(rows?.[0].surface_id, "surf-column");
  });

  test("a row with neither is null rather than a fabricated id", async () => {
    await change({ surfaceId: null, overlayId: null });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.equal(rows?.[0].surface_id, null);
    // It is still a real change, so it is still reported -- just unidentified.
    const card = buildSurfaceHistory(rows, NETUID);
    assert.equal(card.change_count, 1);
    assert.equal(card.surface_count, 0);
  });
});

describe("loadSurfaceHistory", () => {
  test("scopes to the subnet, newest first", async () => {
    await change({ at: T, overlayId: "a" });
    await change({ at: T - 1000, overlayId: "b" });
    await change({ at: T + 1000, netuid: 99, overlayId: "other" });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.deepEqual(
      rows?.map((r) => r.surface_id),
      ["a", "b"],
    );
  });

  test("lifts kind, url and name out of the overlay", async () => {
    await change({
      kind: "openapi",
      url: "https://x.test/openapi.json",
      name: "Spec",
    });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.equal(rows?.[0].kind, "openapi");
    assert.equal(rows?.[0].url, "https://x.test/openapi.json");
    assert.equal(rows?.[0].name, "Spec");
  });

  test("honours the limit", async () => {
    for (let i = 0; i < 5; i += 1)
      await change({ at: T - i * 1000, overlayId: `s${i}` });
    const rows = await loadSurfaceHistory(store(), NETUID, { limit: 2 });
    assert.equal(rows?.length, 2);
  });

  test("no binding and a failed read both return null", async () => {
    assert.equal(await loadSurfaceHistory(null, NETUID), null);
    // beforeEach re-applies the migrations, so this does not leak into the
    // rest of the file the way it would with a plain TRUNCATE.
    await db.exec("DROP TABLE surface_history");
    assert.equal(await loadSurfaceHistory(store(), NETUID), null);
  });
});

describe("buildSurfaceHistory", () => {
  test("counts distinct surfaces, not changes", async () => {
    // The same surface updated three times is ONE surface with three changes.
    await change({ overlayId: "a", at: T });
    await change({ overlayId: "a", at: T - 1 });
    await change({ overlayId: "a", at: T - 2 });
    await change({ overlayId: "b", at: T - 3 });
    const card = buildSurfaceHistory(
      await loadSurfaceHistory(store(), NETUID),
      NETUID,
    );
    assert.equal(card.change_count, 4);
    assert.equal(card.surface_count, 2);
  });

  test("keeps a delete, which is the only trace a surface ever existed", async () => {
    await change({ action: "delete", surfaceId: "gone", at: T });
    const card = buildSurfaceHistory(
      await loadSurfaceHistory(store(), NETUID),
      NETUID,
    );
    assert.equal((card.changes as Row[])[0].action, "delete");
    assert.equal((card.changes as Row[])[0].surface_id, "gone");
  });

  test("an unrecognised action is nulled, not passed through", () => {
    // It reaches the payload as a published enum; an unknown string would
    // either break a typed client or teach a vocabulary this API does not have.
    const card = buildSurfaceHistory(
      [{ action: "obliterate", recorded_at: T, surface_id: "a" }],
      NETUID,
    );
    assert.equal((card.changes as Row[])[0].action, null);
    for (const a of SURFACE_HISTORY_ACTIONS) {
      const ok = buildSurfaceHistory([{ action: a, recorded_at: T }], NETUID);
      assert.equal((ok.changes as Row[])[0].action, a);
    }
  });

  test("a row with no usable timestamp is dropped", () => {
    // A trail is an ordering, so an entry that cannot be placed in it is worse
    // than absent.
    const card = buildSurfaceHistory(
      [
        { action: "update", recorded_at: 0, surface_id: "a" },
        { action: "update", recorded_at: null, surface_id: "b" },
        { action: "update", recorded_at: T, surface_id: "c" },
      ],
      NETUID,
    );
    assert.equal(card.change_count, 1);
    assert.equal((card.changes as Row[])[0].surface_id, "c");
  });

  test("an out-of-range timestamp is dropped, not a thrown RangeError", () => {
    const card = buildSurfaceHistory(
      [{ action: "update", recorded_at: 1e300, surface_id: "a" }],
      NETUID,
    );
    assert.equal(card.change_count, 0);
  });

  test("empty and unreadable inputs are cards, not throws", () => {
    for (const rows of [null, undefined, [], "nope" as unknown]) {
      const card = buildSurfaceHistory(rows as never, NETUID);
      assert.equal(card.change_count, 0);
      assert.equal(card.surface_count, 0);
      assert.equal(card.latest_change_at, null);
      assert.deepEqual(card.changes, []);
    }
  });

  test("an empty string field is null rather than an empty string", () => {
    const card = buildSurfaceHistory(
      [
        {
          action: "update",
          recorded_at: T,
          surface_id: "",
          kind: "",
          url: "",
          name: "",
          source_commit: "",
        },
      ],
      NETUID,
    );
    const c = (card.changes as Row[])[0];
    assert.equal(c.surface_id, null);
    assert.equal(c.kind, null);
    assert.equal(c.source_commit, null);
  });

  test("an omitted options object takes the default limit", async () => {
    // The loader's default-parameter arm, which a fully-specified call never
    // reaches -- and it is what every caller that does not paginate uses.
    for (let i = 0; i < 3; i += 1)
      await change({ at: T - i, overlayId: `s${i}` });
    const rows = await loadSurfaceHistory(store(), NETUID);
    assert.equal(rows?.length, 3);
  });

  test("the limit and its ceiling are the shared pair", () => {
    assert.equal(SURFACE_HISTORY_LIMIT_DEFAULT, 50);
    assert.equal(SURFACE_HISTORY_LIMIT_MAX, 200);
    assert.equal(buildSurfaceHistory([], NETUID).limit, null);
    assert.equal(buildSurfaceHistory([], NETUID, { limit: 10 }).limit, 10);
  });
});

describe("GET /api/v1/subnets/{netuid}/surface-history", () => {
  const get = (p: string, e?: Env) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${p}`),
      e ?? env(),
      {} as unknown as ExecutionContext,
    );
  const body = async (res: Response) => {
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    return ((await res.json()) as Row).data as Row;
  };

  test("serves the trail", async () => {
    await change({ overlayId: "a", action: "insert" });
    const data = await body(
      await get(`/api/v1/subnets/${NETUID}/surface-history`),
    );
    assert.equal(data.netuid, NETUID);
    assert.equal(data.change_count, 1);
    assert.equal(data.limit, SURFACE_HISTORY_LIMIT_DEFAULT);
  });

  test("a subnet that never changed is an empty trail, not a 404", async () => {
    const data = await body(
      await get(`/api/v1/subnets/${NETUID}/surface-history`),
    );
    assert.equal(data.change_count, 0);
    assert.deepEqual(data.changes, []);
  });

  test("an out-of-u16 netuid is a 400", async () => {
    assert.equal(
      (await get("/api/v1/subnets/70000/surface-history")).status,
      400,
    );
  });

  test("an over-ceiling limit is rejected, not clamped", async () => {
    const res = await get(
      `/api/v1/subnets/${NETUID}/surface-history?limit=${SURFACE_HISTORY_LIMIT_MAX + 1}`,
    );
    assert.equal(res.status, 400);
  });

  test("an unknown query parameter is rejected", async () => {
    assert.equal(
      (await get(`/api/v1/subnets/${NETUID}/surface-history?action=insert`))
        .status,
      400,
    );
  });

  test("no store binding is an empty trail rather than a 500", async () => {
    const data = await body(
      await get(`/api/v1/subnets/${NETUID}/surface-history`, {} as Env),
    );
    assert.equal(data.change_count, 0);
  });

  test("the path is anchored, so a deeper path is not this route", async () => {
    const res = await get(`/api/v1/subnets/${NETUID}/surface-history/extra`);
    assert.notEqual(res.status, 200);
  });
});

describe("subnet_surface_history over GraphQL and MCP", () => {
  test("GraphQL serves the same trail", async () => {
    await change({ overlayId: "a", action: "delete" });
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ subnet_surface_history(netuid: ${NETUID}) {
            netuid change_count surface_count
            changes { surface_id action kind url source_commit recorded_at } } }`,
        }),
      }),
      env(),
    );
    const card = (((await res.json()) as Row).data as Row)
      .subnet_surface_history as Row;
    assert.equal(card.change_count, 1);
    assert.equal((card.changes as Row[])[0].action, "delete");
  });

  // CLAMPS since #10316, matching the MCP tool below rather than diverging
  // from it -- the two now answer the same page for the same argument.
  test("GraphQL clamps an over-max limit to the published ceiling", async () => {
    const res = await handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ subnet_surface_history(netuid: ${NETUID}, limit: ${SURFACE_HISTORY_LIMIT_MAX + 1}) { netuid } }`,
        }),
      }),
      env(),
    );
    const body = (await res.json()) as Row;
    assert.equal(body.errors, undefined);
    assert.equal((body.data as Row)?.subnet_surface_history?.netuid, NETUID);
  });

  test("the MCP tool serves it and clamps its limit", async () => {
    await change({ overlayId: "a" });
    const tool = MCP_TOOLS.find((t) => t.name === "get_subnet_surface_history");
    assert.ok(tool, "get_subnet_surface_history is not registered");
    const card = (await tool.handler(
      { netuid: NETUID, limit: SURFACE_HISTORY_LIMIT_MAX + 50 } as never,
      { env: env() } as never,
    )) as Row;
    assert.equal(card.limit, SURFACE_HISTORY_LIMIT_MAX);
    assert.equal(card.change_count, 1);
    // The one fact a model must not lose: a delete is the only trace.
    assert.match(tool.description, /ONLY\s+evidence a surface ever existed/);
  });

  test("the MCP tool rejects an out-of-u16 netuid", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_subnet_surface_history");
    await assert.rejects(() =>
      tool!.handler({ netuid: 70000 } as never, { env: env() } as never),
    );
  });
});
