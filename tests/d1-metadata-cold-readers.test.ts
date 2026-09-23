import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readStateArchiveRows } from "../src/state-archive-read.ts";
import { beforeAll, afterAll, afterEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  loadAccountIdentityColdTier,
  loadAccountIdentityHistoryColdTier,
} from "../src/account-identity-cold-tier.ts";
import {
  loadSubnetHyperparamsColdTier,
  loadSubnetHyperparamsHistoryColdTier,
} from "../src/subnet-hyperparams-cold-tier.ts";
import {
  loadSubnetIdentityHistoryColdTier,
  loadChainIdentityHistoryColdTier,
} from "../src/subnet-identity-cold-tier.ts";
import { loadSubnetOwnerObservations } from "../src/subnet-ownership-cold-tier.ts";
import { loadSelfHealthColdTier } from "../src/self-health-cold-tier.ts";
import { readD1Metadata } from "../src/d1-metadata-read.ts";
import { encodeCursor } from "../src/cursor.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const account = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const now = Date.UTC(2026, 8, 23, 12);
let db: D1Database;
const tables =
  "account_identity,account_identity_history,subnet_hyperparams,subnet_hyperparams_history,subnet_identity_history,subnet_ownership_history,self_health_checks,self_health_daily";
type FixtureObject = { raw: string; etag: string; size: number };
const objects: Record<string, FixtureObject> = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "./fixtures/native-projections/state-archive.json.gz",
        import.meta.url,
      ),
    ),
  ).toString(),
);
function archiveFixture() {
  const records = structuredClone(objects);
  return {
    records,
    bucket: {
      async get(key: string) {
        const object = records[key];
        return object
          ? {
              ...object,
              async json() {
                return JSON.parse(object.raw);
              },
            }
          : null;
      },
    },
  };
}
const env = () => ({
  METAGRAPH_ARCHIVE: archiveFixture().bucket,
  D1_STATE: db,
  D1_STATE_TABLES: tables,
  R2_SQL_TOKEN: "cfut_test",
});
async function seed(sql: string, ...values: (number | string | null)[]) {
  const stmt = db.prepare(sql);
  await (values.length ? stmt.bind(...values) : stmt).run();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of [
    "0009_subnet_identity_state.sql",
    "0013_registry_self_health.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  await seed(
    "INSERT INTO account_identity(account,name,captured_at) VALUES(?,?,?)",
    account,
    "D1 latest",
    now,
  );
  await seed(
    "INSERT INTO subnet_hyperparams(netuid,tempo,registration_allowed,commit_reveal_enabled,captured_at) VALUES(7,360,1,0,?)",
    now,
  );
  for (const n of [1, 2, 3]) {
    await seed(
      "INSERT INTO account_identity_history(account,name,observed_at,identity_hash) VALUES(?,?,?,?)",
      account,
      `name-${n}`,
      now + n,
      `i${n}`,
    );
    await seed(
      "INSERT INTO subnet_hyperparams_history(netuid,tempo,registration_allowed,commit_reveal_enabled,observed_at,hyperparams_hash) VALUES(7,?,?,?,?,?)",
      n,
      1,
      0,
      now + n,
      `h${n}`,
    );
    await seed(
      "INSERT INTO subnet_identity_history(netuid,block_number,observed_at,subnet_name,identity_hash) VALUES(7,100,?,?,?)",
      now,
      `subnet-${n}`,
      `s${n}`,
    );
    await seed(
      "INSERT INTO subnet_ownership_history(netuid,owner_hotkey,owner_coldkey,captured_at) VALUES(7,?,?,?)",
      `hot-${n}`,
      `cold-${n}`,
      now + n,
    );
  }
  await seed(
    "INSERT INTO subnet_identity_history(netuid,block_number,observed_at,subnet_name,identity_hash) VALUES(8,101,?,?,?)",
    now,
    "other-subnet",
    "other",
  );
  await seed(
    "INSERT INTO self_health_daily(day,component,checks,ok_count) VALUES('2026-09-23','api',2,1),('2020-01-01','api',1,0)",
  );
  await seed(
    "INSERT INTO self_health_checks(component,checked_at_ms,ok,http_status,latency_ms) VALUES('api',?,1,200,10),('api',?,0,503,30)",
    now - 1,
    now,
  );
}, 30_000);
afterAll(async () => runtime.dispose());
afterEach(() => vi.unstubAllGlobals());

function forbidSql() {
  const fetch = vi.fn(async () => {
    throw new Error("R2 SQL must not run for a selected owner");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("current identities and hyperparameters preserve nulls and SQLite booleans", async () => {
  const fetch = forbidSql();
  const identity = await loadAccountIdentityColdTier(env(), account);
  assert.equal(identity?.name, "D1 latest");
  assert.equal(identity?.github, null);
  assert.equal(
    (await loadAccountIdentityColdTier(env(), account.slice(0, -1) + "G"))
      ?.has_identity,
    false,
  );
  const params = await loadSubnetHyperparamsColdTier(env(), 7);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(params!.hyperparameters as object).filter(([k]) =>
        ["tempo", "registration_allowed", "commit_reveal_enabled"].includes(k),
      ),
    ),
    { tempo: 360, registration_allowed: true, commit_reveal_enabled: false },
  );
  assert.equal(
    (await loadSubnetHyperparamsColdTier(env(), 999))?.hyperparameters,
    null,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("native histories keep exact tuple pagination, offset and confirmed empty semantics", async () => {
  const fetch = forbidSql();
  const accountPage = await loadAccountIdentityHistoryColdTier(env(), account, {
    limit: 1,
  });
  assert.equal(accountPage?.entries[0]?.name, "name-3");
  assert.equal(
    (
      await loadAccountIdentityHistoryColdTier(env(), account, {
        limit: 1,
        offset: 9999,
        cursor: accountPage?.next_cursor,
      })
    )?.entries[0]?.name,
    "name-2",
  );
  assert.equal(
    (
      await loadAccountIdentityHistoryColdTier(env(), account, {
        limit: 1,
        offset: 1,
      })
    )?.entries[0]?.name,
    "name-2",
  );
  assert.equal(
    (
      await loadAccountIdentityHistoryColdTier(env(), account, {
        limit: 1,
        offset: 9999,
      })
    )?.entry_count,
    0,
  );
  const sub = await loadSubnetIdentityHistoryColdTier(env(), 7, { limit: 1 });
  assert.equal(
    (sub?.entries as { subnet_name: string }[])[0]?.subnet_name,
    "subnet-3",
  );
  const next = await loadSubnetIdentityHistoryColdTier(env(), 7, {
    limit: 1,
    cursor: sub?.next_cursor,
    offset: 8,
  });
  assert.equal(
    (next?.entries as { subnet_name: string }[])[0]?.subnet_name,
    "subnet-2",
  );
  assert.deepEqual(
    await loadSubnetIdentityHistoryColdTier(env(), 7, { limit: 1, offset: 1 }),
    { ...next, offset: 1 },
  );
  assert.equal(
    (
      await loadSubnetIdentityHistoryColdTier(env(), 7, {
        limit: 1,
        offset: 9999,
      })
    )?.entry_count,
    0,
  );
  const hp = await loadSubnetHyperparamsHistoryColdTier(env(), 7, { limit: 1 });
  const hpNext = await loadSubnetHyperparamsHistoryColdTier(env(), 7, {
    limit: 1,
    cursor: hp?.next_cursor,
    offset: 8,
  });
  assert.equal(
    (hpNext?.entries as { hyperparameters: { tempo: number } }[])[0]
      ?.hyperparameters.tempo,
    2,
  );
  assert.deepEqual(
    await loadSubnetHyperparamsHistoryColdTier(env(), 7, {
      limit: 1,
      offset: 1,
    }),
    { ...hpNext, offset: 1 },
  );
  assert.equal(
    (
      await loadSubnetHyperparamsHistoryColdTier(env(), 7, {
        limit: 1,
        offset: 9999,
      })
    )?.entry_count,
    0,
  );
  assert.equal(
    (
      await loadSubnetIdentityHistoryColdTier(env(), 7, {
        limit: 1,
        cursor: encodeCursor([now, 2]),
      })
    )?.next_cursor,
    encodeCursor([now, 1]),
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("network identity ordering and ownership observations retain the archived history", async () => {
  const fetch = forbidSql();
  const chain = await loadChainIdentityHistoryColdTier(env(), { limit: 2 });
  assert.deepEqual(
    (chain?.changes as { netuid: number; subnet_name: string }[]).map((r) => [
      r.netuid,
      r.subnet_name,
    ]),
    [
      [8, "other-subnet"],
      [7, "subnet-3"],
    ],
  );
  assert.deepEqual(await loadSubnetOwnerObservations(env(), 7), [
    { owner_coldkey: "legacy", captured_at: now - 60 * 86400000 },
    ...[1, 2, 3].map((n) => ({
      owner_coldkey: `cold-${n}`,
      captured_at: now + n,
    })),
  ]);
  assert.deepEqual(await loadSubnetOwnerObservations(env(), 999), []);
  assert.equal(await loadSubnetOwnerObservations(env(), -1), null);
  assert.equal(fetch.mock.calls.length, 0);
});
test("self-health reads only measured current ticks and the retained daily window", async () => {
  const fetch = forbidSql();
  const health = await loadSelfHealthColdTier(env(), now);
  assert.equal(health?.verdict, "outage");
  const api = health?.components.find((x) => x.component === "api");
  assert.equal(api?.current_ok, false);
  assert.equal(api?.http_status, 503);
  assert.equal(api?.days.length, 1);
  assert.equal(api?.days[0]?.checks, 2);
  assert.equal(fetch.mock.calls.length, 0);
});
test("selected missing and failing bindings decline without archived queries", async () => {
  const fetch = forbidSql();
  const missing = { ...env(), D1_STATE: undefined };
  const failing = {
    ...env(),
    D1_STATE: {
      prepare() {
        throw new Error("store unavailable");
      },
      batch: db.batch.bind(db),
    },
  };
  for (const e of [missing, failing]) {
    assert.equal(await loadAccountIdentityColdTier(e, account), null);
    assert.equal(await loadSubnetHyperparamsColdTier(e, 7), null);
    assert.equal(await loadSelfHealthColdTier(e, now), null);
  }
  assert.equal(
    await readD1Metadata({}, "account_identity", "SELECT 1"),
    undefined,
  );
  assert.deepEqual(
    await readD1Metadata(env(), "account_identity", "SELECT 1 AS value"),
    [{ value: 1 }],
  );
  const partial = { ...env(), D1_STATE_TABLES: "self_health_daily" };
  assert.equal(await loadSelfHealthColdTier(partial, now), null);
  assert.equal(fetch.mock.calls.length, 0);
});

test("legacy records absent from D1 preserve original IDs and exact pagination", async () => {
  const fetch = forbidSql();
  assert.equal(
    (
      await loadAccountIdentityHistoryColdTier(env(), account, {
        limit: 1,
        cursor: encodeCursor([now + 1, 1]),
      })
    )?.entries[0]?.name,
    "legacy",
  );
  assert.equal(
    (
      (
        await loadSubnetIdentityHistoryColdTier(env(), 7, {
          limit: 1,
          cursor: encodeCursor([now, 1]),
        })
      )?.entries as { subnet_name: string }[]
    )[0]?.subnet_name,
    "legacy",
  );
  const hp = await loadSubnetHyperparamsHistoryColdTier(env(), 7, {
    limit: 1,
    cursor: encodeCursor([now + 1, 1]),
  });
  assert.equal(
    (hp?.entries as { hyperparameters: { tempo: number } }[])[0]
      ?.hyperparameters.tempo,
    77,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("archive selection requires complete source census, immutable identity and canonical rows", async () => {
  const table = "account_identity_history";
  const pointer = `metagraph/state-archive/v1/${table}/current.json`;
  assert.equal(await readStateArchiveRows({}, table), undefined);
  assert.equal(
    await readStateArchiveRows(
      {
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
        },
      },
      table,
    ),
    undefined,
  );
  assert.equal(
    await readStateArchiveRows(
      {
        METAGRAPH_ARCHIVE: {
          async get() {
            throw Error("unavailable");
          },
        },
      },
      table,
    ),
    null,
  );
  const edits: ((
    records: Record<string, FixtureObject>,
    manifest: {
      version: number;
      table: string;
      rowCount: number;
      object: { key: string };
      source: { sources: { table: string }[] };
    },
    body: {
      version: number;
      table: string;
      generation: string;
      rows: Record<string, unknown>[];
    },
  ) => void)[] = [
    (r) => {
      delete (r[pointer] as Partial<FixtureObject>).size;
    },
    (r) => {
      r[pointer].size = 0;
    },
    (r) => {
      r[pointer].size = 1024 * 1024 + 1;
    },
    (_r, m) => {
      m.version = 2;
    },
    (_r, m) => {
      m.table = "other";
    },
    (_r, m) => {
      m.object.key = "escape";
    },
    (_r, m) => {
      m.source.sources[0].table = "other";
    },
    (_r, m) => {
      m.rowCount++;
    },
    (r, m) => {
      delete r[m.object.key];
    },
    (r, m) => {
      r[m.object.key].etag = "changed";
    },
    (r, m) => {
      r[m.object.key].size++;
    },
    (_r, _m, b) => {
      b.version = 2;
    },
    (_r, _m, b) => {
      b.table = "other";
    },
    (_r, _m, b) => {
      b.generation = "changed";
    },
    (_r, _m, b) => {
      b.rows.pop();
    },
    (_r, _m, b) => {
      b.rows[0].observed_at = "bad";
    },
    (_r, _m, b) => {
      delete b.rows[0].identity_hash;
    },
  ];
  for (const edit of edits) {
    const f = archiveFixture();
    const m = JSON.parse(f.records[pointer].raw);
    const key = m.object.key;
    const b = JSON.parse(f.records[key].raw);
    edit(f.records, m, b);
    f.records[pointer].raw = JSON.stringify(m);
    if (f.records[key]) f.records[key].raw = JSON.stringify(b);
    assert.equal(
      await readStateArchiveRows({ METAGRAPH_ARCHIVE: f.bucket }, table),
      null,
    );
  }
  const broken = {
    ...env(),
    METAGRAPH_ARCHIVE: {
      async get() {
        throw Error("broken");
      },
    },
  };
  const fetch = forbidSql();
  assert.equal(
    await loadAccountIdentityHistoryColdTier(broken, account, { limit: 1 }),
    null,
  );
  assert.equal(
    await loadSubnetIdentityHistoryColdTier(broken, 7, { limit: 1 }),
    null,
  );
  assert.equal(
    await loadSubnetHyperparamsHistoryColdTier(broken, 7, { limit: 1 }),
    null,
  );
  assert.equal(await loadChainIdentityHistoryColdTier(broken), null);
  assert.equal(await loadSubnetOwnerObservations(broken, 7), null);
  assert.equal(fetch.mock.calls.length, 0);
});
