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
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  SURFACE_HISTORY_ACTIONS,
  SURFACE_HISTORY_LIMIT_DEFAULT,
  SURFACE_HISTORY_LIMIT_MAX,
  buildSurfaceHistory,
  loadSurfaceHistory,
} from "../src/surface-history.ts";
import { handleRequest } from "../workers/api.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// The real registry DDL, so the table under test is the one production has.
const SCHEMA = (() => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "migrations/d1/0001_registry.sql"),
    "utf8",
  );
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS surface_history");
  return sql.slice(start, sql.indexOf(");", start) + 2);
})();

const NETUID = 7;
const T = 1_785_642_908_000;

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
  };
}
const env = () => ({ METAGRAPH_HEALTH_DB: d1() }) as unknown as Env;

function change({
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
  db.prepare(
    `INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(surfaceId, netuid, action, JSON.stringify(overlay), commit, at);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("identity survives a missing surface_id column", () => {
  test("recovers the id from the overlay when the column is null", async () => {
    // The shape 8,831 of 8,892 production rows had before 0024, and the shape a
    // pre-migration database still has.
    change({ surfaceId: null, overlayId: "surf-abc" });
    const rows = await loadSurfaceHistory(d1(), NETUID);
    assert.equal(rows?.[0].surface_id, "surf-abc");
  });

  test("prefers the column when it is set", async () => {
    // A delete row, and every row after the writer fix.
    change({ surfaceId: "surf-column", overlayId: "surf-overlay" });
    const rows = await loadSurfaceHistory(d1(), NETUID);
    assert.equal(rows?.[0].surface_id, "surf-column");
  });

  test("a row with neither is null rather than a fabricated id", async () => {
    change({ surfaceId: null, overlayId: null });
    const rows = await loadSurfaceHistory(d1(), NETUID);
    assert.equal(rows?.[0].surface_id, null);
    // It is still a real change, so it is still reported -- just unidentified.
    const card = buildSurfaceHistory(rows, NETUID);
    assert.equal(card.change_count, 1);
    assert.equal(card.surface_count, 0);
  });
});

describe("loadSurfaceHistory", () => {
  test("scopes to the subnet, newest first", async () => {
    change({ at: T, overlayId: "a" });
    change({ at: T - 1000, overlayId: "b" });
    change({ at: T + 1000, netuid: 99, overlayId: "other" });
    const rows = await loadSurfaceHistory(d1(), NETUID);
    assert.deepEqual(
      rows?.map((r) => r.surface_id),
      ["a", "b"],
    );
  });

  test("lifts kind, url and name out of the overlay", async () => {
    change({
      kind: "openapi",
      url: "https://x.test/openapi.json",
      name: "Spec",
    });
    const rows = await loadSurfaceHistory(d1(), NETUID);
    assert.equal(rows?.[0].kind, "openapi");
    assert.equal(rows?.[0].url, "https://x.test/openapi.json");
    assert.equal(rows?.[0].name, "Spec");
  });

  test("honours the limit", async () => {
    for (let i = 0; i < 5; i += 1)
      change({ at: T - i * 1000, overlayId: `s${i}` });
    const rows = await loadSurfaceHistory(d1(), NETUID, { limit: 2 });
    assert.equal(rows?.length, 2);
  });

  test("no binding and a failed read both return null", async () => {
    assert.equal(await loadSurfaceHistory(null, NETUID), null);
    db.exec("DROP TABLE surface_history");
    assert.equal(await loadSurfaceHistory(d1(), NETUID), null);
  });
});

describe("buildSurfaceHistory", () => {
  test("counts distinct surfaces, not changes", async () => {
    // The same surface updated three times is ONE surface with three changes.
    change({ overlayId: "a", at: T });
    change({ overlayId: "a", at: T - 1 });
    change({ overlayId: "a", at: T - 2 });
    change({ overlayId: "b", at: T - 3 });
    const card = buildSurfaceHistory(
      await loadSurfaceHistory(d1(), NETUID),
      NETUID,
    );
    assert.equal(card.change_count, 4);
    assert.equal(card.surface_count, 2);
  });

  test("keeps a delete, which is the only trace a surface ever existed", async () => {
    change({ action: "delete", surfaceId: "gone", at: T });
    const card = buildSurfaceHistory(
      await loadSurfaceHistory(d1(), NETUID),
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
    for (let i = 0; i < 3; i += 1) change({ at: T - i, overlayId: `s${i}` });
    const rows = await loadSurfaceHistory(d1(), NETUID);
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
    change({ overlayId: "a", action: "insert" });
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

  test("no D1 binding is an empty trail rather than a 500", async () => {
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
    change({ overlayId: "a", action: "delete" });
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

  test("GraphQL validates the limit rather than clamping", async () => {
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
    const errors = ((await res.json()) as Row).errors as Row[];
    assert.equal((errors[0].extensions as Row)?.code, "BAD_USER_INPUT");
  });

  test("the MCP tool serves it and clamps its limit", async () => {
    change({ overlayId: "a" });
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
