import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, afterEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  ledgerCapturedAt,
  latestStakeEventAt,
  loadAccountPositionsColdTier,
} from "../src/nominator-positions-cold-tier.ts";
import { accountSummaryArchive } from "./helpers/cold-tier-env.ts";
import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";

const account = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const other = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "./fixtures/account-feeds/position-tree.json.gz",
        import.meta.url,
      ),
    ),
  ).toString(),
) as {
  manifest: HistoryAccountFeed;
  selection: HistoryAccountFeed["selection"];
  rows: AccountEventsRow[];
  objects: Record<string, { etag: string; base64: string }>;
};
function archive(floor = false) {
  const feed = structuredClone(fixture.manifest);
  const selected = structuredClone(fixture.selection);
  const base = `metagraph/indexed-history/v1/mainnet/account_events`;
  const root = `${base}/generations/${selected.generation}`;
  const objects = new Map(
    Object.entries(fixture.objects).map(([key, value]) => [
      key,
      { raw: Buffer.from(value.base64, "base64"), etag: value.etag },
    ]),
  );
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value));
    const etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag });
    return { key, etag, bytes: raw.length };
  };
  selected.blockManifest = put(`${root}/block-manifest.json`, {
    version: 1,
    network: "mainnet",
    table: "account_events",
    generation: selected.generation,
    state: "complete",
    sourceSnapshot: feed.sourceSnapshot,
    rows: feed.rows,
    files: [
      {
        key: `${root}/files/00000.json`,
        etag: "source",
        bytes: 1,
        rows: feed.rows,
      },
    ],
    blockIndex: { key: `${root}/blocks/index.json`, etag: "index", bytes: 1 },
  });
  feed.selection = selected;
  const manifest = `${root}/accounts/v1/manifest.json`;
  put(`${base}/current.json`, { version: 1, ...selected });
  put(manifest, feed);
  put(`${base}/source-ceiling.json`, {
    version: 1,
    network: "mainnet",
    table: "account_events",
    through: selected.lastBlock,
    revision: "a".repeat(32),
  });
  const summary = accountSummaryArchive({
    accounts: { [account]: null },
    through: "1970-01-01",
  });
  return {
    objects,
    put,
    manifest,
    async get(key: string, options?: R2GetOptions) {
      if (floor && key.includes("account-summary/"))
        return summary.METAGRAPH_ARCHIVE.get(key);
      const object = objects.get(key);
      if (!object) return null;
      const range =
        options?.range && "offset" in options.range ? options.range : undefined;
      const offset = range?.offset ?? 0,
        length = range?.length ?? object.raw.length;
      return {
        etag: object.etag,
        size: object.raw.length,
        range: { offset, length },
        body: new Response(object.raw.subarray(offset, offset + length)).body,
        json: async () => JSON.parse(object.raw.toString()),
      };
    },
  };
}
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const env = (bucket = archive()) => ({
  D1_STATE: db,
  D1_STATE_TABLES: "nominator_positions,neurons",
  R2_SQL_TOKEN: "cfut_test",
  METAGRAPH_ARCHIVE: bucket,
});
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of ["0007_neuron_documents.sql", "0010_ledger_state.sql"]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  await db
    .prepare(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES(?,?,7,0.5,9000),(?,?,8,0.25,9000)",
    )
    .bind(account, other, account, other)
    .run();
  for (const netuid of [7, 8]) {
    await db
      .prepare(
        "INSERT INTO neurons_members(netuid,uid,hotkey,shard) VALUES(?,1,?,0)",
      )
      .bind(netuid, other)
      .run();
    await db
      .prepare(
        "INSERT INTO neurons_documents(netuid,day,shard,stamp,payload) VALUES(?,'',0,1790186400000,jsonb(?))",
      )
      .bind(
        netuid,
        JSON.stringify({ 1: { stake_tao: netuid === 7 ? 100 : 40 } }),
      )
      .run();
  }
}, 30_000);
afterAll(async () => runtime.dispose());
afterEach(() => vi.unstubAllGlobals());
function forbidSql() {
  const fetch = vi.fn(async () => {
    throw Error("Native positions must not query R2 SQL");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("D1 position fallbacks keep exact live stake pricing and current capture stamps", async () => {
  const fetch = forbidSql();
  const value = await loadAccountPositionsColdTier(env(), account);
  assert.equal(value?.position_count, 2);
  assert.equal(value?.total_stake_alpha, 60);
  assert.equal(await ledgerCapturedAt(env()), 9000);
  const empty = await loadAccountPositionsColdTier(env(), other);
  assert.equal(empty?.position_count, 0);
  assert.equal(empty?.captured_at, new Date(9000).toISOString());
  assert.equal(fetch.mock.calls.length, 0);
});
test("complete native stake feeds find the newest matching physical row and respect the account floor", async () => {
  const fetch = forbidSql();
  const wanted = Math.max(
    ...fixture.rows
      .filter(
        (row) =>
          row.coldkey === account &&
          ["StakeAdded", "StakeRemoved"].includes(row.event_kind!),
      )
      .map((row) => row.observed_at!),
  );
  assert.equal(await latestStakeEventAt(env(), account), wanted);
  assert.equal(await latestStakeEventAt(env(), other), null);
  assert.equal(await latestStakeEventAt(env(archive(true)), account), null);
  const broken = archive();
  broken.put(broken.manifest, { version: 2 });
  assert.equal(await latestStakeEventAt(env(broken), account), null);
  assert.equal(fetch.mock.calls.length, 0);
});
test("selected ledger failures decline even when a fallback token exists", async () => {
  const fetch = forbidSql();
  for (const binding of [
    undefined,
    {
      prepare() {
        throw Error("down");
      },
      batch: db.batch.bind(db),
    },
  ]) {
    const e = { ...env(), D1_STATE: binding };
    assert.equal(await loadAccountPositionsColdTier(e, account), null);
    assert.equal(await ledgerCapturedAt(e), null);
  }
  assert.equal(fetch.mock.calls.length, 0);
});
test("a native ledger beyond the position cap declines before pricing a partial set", async () => {
  const fetch = forbidSql();
  await db
    .prepare(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2001) INSERT INTO nominator_positions(coldkey,hotkey,netuid,captured_at) SELECT ?, 'cap-'||i, 7, 8000 FROM n",
    )
    .bind(other)
    .run();
  try {
    assert.equal(await loadAccountPositionsColdTier(env(), other), null);
  } finally {
    await db
      .prepare("DELETE FROM nominator_positions WHERE coldkey=?")
      .bind(other)
      .run();
  }
  assert.equal(fetch.mock.calls.length, 0);
});
