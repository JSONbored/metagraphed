import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import { loadNativeAccountWeightSetters } from "../src/account-weight-setters-native.ts";
import { loadAccountWeightSettersColdTier } from "../src/account-feeds-cold-tier.ts";
import { buildAccountWeightSetters } from "../src/account-weight-setters.ts";
import { NATIVE_FIXTURE_ENV } from "./helpers/native-fixture-token.ts";

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "./fixtures/native-weight-setters/snapshot.json.gz",
        import.meta.url,
      ),
    ),
  ).toString(),
);
const now: number = fixture.now,
  DAY = 86_400_000;
const root = "metagraph/account-weight-setters-native/v1/mainnet";
const slots = [
  { netuid: 7, uid: 3 },
  { netuid: 19, uid: 4 },
];
const id = (s: string) => createHash("sha256").update(s).digest("hex");

function store() {
  const objects = new Map<string, { body: string; etag: string; size: number }>(
    Object.entries(structuredClone(fixture.objects)),
  );
  const manifest = JSON.parse(
    Buffer.from(objects.get(`${root}/current.json`)!.body, "base64").toString(),
  );
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value));
    objects.set(key, {
      body: raw.toString("base64"),
      etag: "fixture",
      size: raw.length,
    });
  };
  const publish = () => {
    put(`${root}/current.json`, manifest);
    put(`${root}/${manifest.generation}/manifest.json`, manifest);
  };
  const reads: { key: string; bytes: number }[] = [];
  let mode = "ok",
    active = 0,
    peak = 0;
  const bucket = {
    async get(
      key: string,
      options?: {
        onlyIf?: { etagMatches: string };
        range?: { offset: number; length: number };
      },
    ) {
      if (mode === "throw") throw Error("R2 unavailable");
      const found = objects.get(key);
      if (!found) return null;
      let raw = Buffer.from(found.body, "base64");
      const range = options?.range;
      if (range) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        if (mode === "missing") return null;
        assert.equal(options?.onlyIf?.etagMatches, found.etag);
        raw = raw.subarray(range.offset, range.offset + range.length);
        if (mode === "truncated") raw = raw.subarray(1);
      }
      reads.push({ key, bytes: raw.length });
      return {
        size: found.size,
        etag: range && mode === "etag" ? "changed" : found.etag,
        range:
          range && mode === "range"
            ? { offset: range.offset + 1, length: range.length }
            : range,
        body: new Response(raw).body!,
        json: async () => JSON.parse(raw.toString()),
      };
    },
  };
  const entry = () =>
    manifest.entries.find(
      (e: { id: string }) => e.id === id(`h:${fixture.hotkey}`),
    );
  const payload = (
    mutate: (value: { selector: string; rows: (number | null)[][] }) => void,
    selector = `h:${fixture.hotkey}`,
  ) => {
    const target = manifest.entries.find(
        (e: { id: string }) => e.id === id(selector),
      ),
      old = objects.get(target.object.key)!;
    const pack = Buffer.from(old.body, "base64"),
      parts: Buffer[] = [];
    let offset = 0;
    for (const item of [...manifest.entries].sort(
      (a, b) => a.offset - b.offset,
    )) {
      let compressed = pack.subarray(item.offset, item.offset + item.length);
      if (item === target) {
        const value = JSON.parse(gunzipSync(compressed).toString());
        mutate(value);
        const raw = Buffer.from(JSON.stringify(value));
        compressed = gzipSync(raw);
        item.rawBytes = raw.length;
      }
      item.offset = offset;
      item.length = compressed.length;
      offset += compressed.length;
      parts.push(compressed);
    }
    const raw = Buffer.concat(parts);
    for (const item of manifest.entries) item.object.bytes = raw.length;
    objects.set(target.object.key, {
      ...old,
      body: raw.toString("base64"),
      size: raw.length,
    });
    publish();
  };
  return {
    objects,
    manifest,
    put,
    publish,
    reads,
    get peak() {
      return peak;
    },
    entry,
    payload,
    env: { METAGRAPH_ARCHIVE: bucket },
    setMode: (v: string) => {
      mode = v;
    },
  };
}
const load = (
  s: ReturnType<typeof store>,
  querySlots = slots,
  cutoff = now - 7 * DAY,
) =>
  loadNativeAccountWeightSetters(
    s.env,
    fixture.hotkey,
    querySlots,
    cutoff,
    now,
  );

test("native identity reads preserve SQLite's hotkey/UID union and both exact windows", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE events(block,event_index,event_kind,hotkey,coldkey,netuid,uid,amount,alpha,observed)",
    );
    const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const row of fixture.records) insert.run(...row);
    for (const days of [7, 30])
      for (const selected of [
        [],
        slots,
        [slots[0], slots[0]],
        [{ netuid: 7, uid: 4 }],
      ]) {
        const distinct = [
          ...new Map(selected.map((s) => [`${s.netuid}:${s.uid}`, s])).values(),
        ];
        const cutoff = now - days * DAY;
        const predicate = distinct.length
          ? ` OR ((hotkey IS NULL OR hotkey='') AND (netuid,uid) IN (${distinct.map(() => "(?,?)").join(",")}))`
          : "";
        const expected = db
          .prepare(
            `SELECT netuid,count(*) AS weight_sets,min(observed) AS first_observed,max(observed) AS last_observed FROM events WHERE event_kind='WeightsSet' AND observed>=? AND (hotkey=?${predicate}) GROUP BY netuid`,
          )
          .all(
            cutoff,
            fixture.hotkey,
            ...distinct.flatMap((s) => [s.netuid, s.uid]),
          );
        const s = store(),
          actual = await load(s, selected, cutoff);
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual)),
          JSON.parse(JSON.stringify(expected)),
        );
        assert.deepEqual(
          buildAccountWeightSetters(actual, fixture.hotkey),
          buildAccountWeightSetters(expected, fixture.hotkey),
        );
        assert.ok(s.reads.length <= distinct.length + 3);
        assert.ok(s.reads.reduce((n, r) => n + r.bytes, 0) < 10000);
      }
  } finally {
    db.close();
  }
});

test("missing owner is distinct from an invalid selected publication", async () => {
  assert.equal(
    await loadNativeAccountWeightSetters({}, fixture.hotkey, slots, now, now),
    undefined,
  );
  const s = store();
  s.objects.delete(`${root}/current.json`);
  assert.equal(await load(s), undefined);
  const empty = store();
  empty.manifest.entries = [];
  empty.manifest.events = 0;
  empty.publish();
  assert.deepEqual(await load(empty), []);
  assert.deepEqual(
    await loadNativeAccountWeightSetters(store().env, "absent", [], now, now),
    [],
  );
});

test("rejects invalid manifest freshness, census, order, scope and immutable proof", async () => {
  const mutations: ((s: ReturnType<typeof store>) => void)[] = [
    (s) => {
      s.manifest.generatedAt = now + 1;
    },
    (s) => {
      s.manifest.generatedAt = now - 3 * 3600000;
    },
    (s) => {
      s.manifest.retainedFrom++;
    },
    (s) => {
      s.manifest.sourceRows = 0;
    },
    (s) => {
      s.manifest.events++;
    },
    (s) => {
      s.manifest.entries.reverse();
    },
    (s) => {
      s.entry().object.key = "other/pack.bin";
    },
    (s) => {
      s.entry().offset = s.entry().object.bytes;
    },
    (s) => {
      s.manifest.network = "testnet";
    },
  ];
  for (const mutate of mutations) {
    const s = store();
    mutate(s);
    s.publish();
    assert.equal(await load(s), null);
  }
  assert.equal(await load(store(), slots, now - 40 * DAY), null);
  for (const size of [0, 8 * 1024 * 1024 + 1]) {
    const s = store();
    s.objects.get(`${root}/current.json`)!.size = size;
    assert.equal(await load(s), null);
  }
  for (const mode of ["missing", "size", "content"]) {
    const s = store(),
      key = `${root}/${s.manifest.generation}/manifest.json`;
    if (mode === "missing") s.objects.delete(key);
    if (mode === "size") s.objects.get(key)!.size++;
    if (mode === "content") {
      const body = JSON.parse(
        Buffer.from(s.objects.get(key)!.body, "base64").toString(),
      );
      body.sourceRows++;
      s.put(key, body);
      s.objects.get(key)!.size = s.objects.get(`${root}/current.json`)!.size;
    }
    assert.equal(await load(s), null);
  }
  const crossed = store();
  crossed.payload((v) => {
    for (const row of v.rows) row[0] = 19;
  }, "u:7:3");
  assert.equal(await load(crossed), null);
});

test("rejects corrupt conditional ranges and decoded payload identities, sizes and ordering", async () => {
  for (const mode of ["throw", "missing", "etag", "range", "truncated"]) {
    const s = store();
    s.setMode(mode);
    assert.equal(await load(s), null);
  }
  for (const delta of [-1, 1]) {
    const s = store();
    s.entry().rawBytes += delta;
    s.publish();
    assert.equal(await load(s), null);
  }
  const mutations: ((v: {
    selector: string;
    rows: (number | null)[][];
  }) => void)[] = [
    (v) => {
      v.selector = "h:wrong";
    },
    (v) => {
      v.rows.pop();
    },
    (v) => {
      v.rows[0][2] = 1;
    },
    (v) => {
      v.rows[0][1] = now - 40 * DAY;
    },
    (v) => {
      v.rows.reverse();
    },
    (v) => {
      v.rows[1][1] = v.rows[0][1];
    },
  ];
  for (const mutate of mutations) {
    const s = store();
    s.payload(mutate);
    assert.equal(await load(s), null);
  }
});

test("lookup and aggregate budgets are checked before body reads", async () => {
  assert.equal(
    await load(
      store(),
      Array.from({ length: 512 }, (_, uid) => ({ netuid: 7, uid })),
    ),
    null,
  );
  for (const raw of [false, true]) {
    const s = store(),
      source = s.entry();
    s.manifest.entries = Array.from({ length: raw ? 9 : 17 }, (_, uid) => ({
      ...structuredClone(source),
      id: id(`u:7:${uid}`),
      offset: 0,
      length: raw ? 1 : 2 * 1024 * 1024,
      rawBytes: raw ? 16 * 1024 * 1024 : 1,
      object: { ...source.object, bytes: 16 * 1024 * 1024 },
    })).sort((a, b) => a.id.localeCompare(b.id));
    s.manifest.events = s.manifest.entries.reduce(
      (n: number, e: { events: number }) => n + e.events,
      0,
    );
    s.manifest.sourceRows = s.manifest.events;
    s.publish();
    assert.equal(
      await load(
        s,
        Array.from({ length: 20 }, (_, uid) => ({ netuid: 7, uid })),
      ),
      null,
    );
    assert.equal(s.reads.length, 2);
  }
});

test("cold-tier integration uses the canonical builder and never scans SQL for a selected index", async () => {
  const date = vi.spyOn(Date, "now").mockReturnValue(now),
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("SQL forbidden"));
  try {
    pg.control.onQuery = () => {
      pg.control.rows = slots;
    };
    const s = store(),
      env = {
        NATIVE_PROJECTIONS: "enabled",
        ...pgMockEnv(),
        ...s.env,
        [NATIVE_FIXTURE_ENV]: "fixture-token",
      };
    const result = await loadAccountWeightSettersColdTier(env, fixture.hotkey, {
      window: "30d",
    });
    const expected = await load(s, slots, now - 30 * DAY);
    assert.deepEqual(
      result?.data,
      buildAccountWeightSetters(expected, fixture.hotkey, { window: "30d" }),
    );
    assert.equal(result?.generatedAt, new Date(now).toISOString());
    s.setMode("throw");
    assert.equal(
      await loadAccountWeightSettersColdTier(env, fixture.hotkey),
      null,
    );
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    date.mockRestore();
    fetch.mockRestore();
    pg.control.onQuery = null;
  }
});

test("many-subnet lookups overlap four pinned ranges without unbounded fan-out", async () => {
  const s = store(),
    parts: Buffer[] = [];
  const many = Array.from({ length: 119 }, (_, i) => ({
    netuid: i,
    uid: i + 1,
  }));
  let offset = 0;
  s.manifest.entries = many.map((slot) => {
    const selector = `u:${slot.netuid}:${slot.uid}`;
    const raw = Buffer.from(
      JSON.stringify({ selector, rows: [[slot.netuid, now, 1]] }),
    );
    const compressed = gzipSync(raw),
      entry = {
        id: id(selector),
        offset,
        length: compressed.length,
        rawBytes: raw.length,
        rows: 1,
        events: 1,
        object: { key: "", etag: "fixture", bytes: 1 },
      };
    offset += compressed.length;
    parts.push(compressed);
    return entry;
  });
  const packed = Buffer.concat(parts),
    key = `${root}/packs/${createHash("sha256").update(packed).digest("hex")}.bin`;
  for (const entry of s.manifest.entries)
    entry.object = { key, etag: "fixture", bytes: packed.length };
  s.manifest.entries.sort((a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id),
  );
  s.manifest.events = many.length;
  s.manifest.sourceRows = many.length;
  s.objects.set(key, {
    body: packed.toString("base64"),
    etag: "fixture",
    size: packed.length,
  });
  s.publish();
  const actual = await load(s, many);
  assert.equal(actual?.length, 119);
  assert.equal(
    actual?.reduce((n, row) => n + row.weight_sets, 0),
    119,
  );
  assert.equal(s.peak, 4);
  assert.equal(s.reads.length, 121);
});
