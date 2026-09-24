import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, afterEach, test, vi } from "vitest";
import {
  loadRpcUsageColdTier,
  windowCutoffMs,
} from "../src/rpc-usage-cold-tier.ts";
import { readNativeRpcRows } from "../src/rpc-usage-native-store.ts";
import { rpcWeightedPercentile } from "../src/rpc-usage-native.ts";
import { formatRpcUsage } from "../src/health-serving.ts";

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/native-rpc/telemetry.json.gz", import.meta.url),
    ),
  ).toString(),
);
const now: number = fixture.now,
  DAY = 86_400_000;
const root = "metagraph/rpc-usage-native/v1";
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
    const groups = new Map<
      number,
      { rows: number; first: number; last: number }
    >();
    for (const c of manifest.chunks) {
      const day = Math.floor(c.first / DAY),
        prior = groups.get(day);
      groups.set(day, {
        rows: (prior?.rows ?? 0) + c.rows,
        first: Math.min(prior?.first ?? Infinity, c.first),
        last: Math.max(prior?.last ?? -Infinity, c.last),
      });
    }
    manifest.days = [...groups]
      .sort((a, b) => a[0] - b[0])
      .map(([day, c]) => ({
        ...manifest.days.find((d: { day: number }) => d.day === day),
        day,
        ...c,
      }));
    put(`${root}/current.json`, manifest);
    put(`${root}/${manifest.generation}/manifest.json`, manifest);
  };
  const get = vi.fn(async (key: string) => {
    const item = objects.get(key);
    if (!item) return null;
    const raw = Buffer.from(item.body, "base64");
    return {
      etag: item.etag,
      size: item.size,
      json: async () => JSON.parse(raw.toString()),
      body: new Blob([raw]).stream(),
    };
  });
  return {
    objects,
    manifest,
    publish,
    put,
    get,
    env: { METAGRAPH_ARCHIVE: { get } } as unknown as Env,
  };
}

function reference(window: string, until: number | null) {
  const bounds = windowCutoffMs(window, now)!;
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE rpc (observed_at INTEGER, network TEXT, endpoint_id TEXT, provider TEXT, ok INTEGER, attempts INTEGER, latency_ms INTEGER, cache TEXT)",
  );
  const insert = db.prepare("INSERT INTO rpc VALUES(?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (const row of fixture.rows)
    for (let n = 0; n < (row[8] ?? 1); n++)
      insert.run(
        ...row
          .slice(0, 8)
          .map((v: unknown) => (typeof v === "boolean" ? Number(v) : v)),
      );
  db.exec("COMMIT");
  const where = `WHERE observed_at >= ${bounds.cutoff}${until === null ? "" : ` AND observed_at < ${until}`}`;
  const all = (sql: string) =>
    db.prepare(sql).all() as Record<string, unknown>[];
  const totals = all(
    `SELECT count(*) total, sum(CASE WHEN ok THEN 1 ELSE 0 END) ok_count, sum(CASE WHEN attempts>1 THEN 1 ELSE 0 END) failover_count, sum(CASE WHEN cache='hit' THEN 1 ELSE 0 END) cache_hits, avg(latency_ms) avg_latency_ms, min(observed_at) observed_from, max(observed_at) observed_at FROM rpc ${where}`,
  )[0];
  if (!totals.total) {
    db.close();
    return null;
  }
  const latencies = all(
    `SELECT latency_ms FROM rpc ${where} AND latency_ms IS NOT NULL ORDER BY latency_ms`,
  ).map((r) => Number(r.latency_ms));
  const percentile = (p: number) => {
    const i = (latencies.length - 1) * p;
    return latencies.length
      ? latencies[Math.floor(i)] +
          (latencies[Math.ceil(i)] - latencies[Math.floor(i)]) * (i % 1)
      : null;
  };
  const common =
    "count(*) requests, sum(CASE WHEN ok THEN 1 ELSE 0 END) ok_count, avg(latency_ms) avg_latency_ms";
  const endpoints = all(
    `SELECT endpoint_id,provider,network,${common} FROM rpc ${where} GROUP BY endpoint_id,provider,network`,
  )
    .sort(
      (a, b) =>
        Number(b.requests) - Number(a.requests) ||
        JSON.stringify({
          endpoint_id: a.endpoint_id,
          provider: a.provider,
          network: a.network,
        }).localeCompare(
          JSON.stringify({
            endpoint_id: b.endpoint_id,
            provider: b.provider,
            network: b.network,
          }),
        ),
    )
    .slice(0, 100);
  const networks = all(
    `SELECT network,${common} FROM rpc ${where} GROUP BY network`,
  )
    .sort(
      (a, b) =>
        Number(b.requests) - Number(a.requests) ||
        JSON.stringify({ network: a.network }).localeCompare(
          JSON.stringify({ network: b.network }),
        ),
    )
    .slice(0, 100);
  const buckets = all(
    `SELECT observed_at - observed_at % ${bounds.bucketMs} ts,${common} FROM rpc ${where} GROUP BY ts ORDER BY ts LIMIT 1000`,
  ).map((r) => ({ ...r, errors: Number(r.requests) - Number(r.ok_count) }));
  db.close();
  return formatRpcUsage({
    window,
    observedAt: totals.observed_at,
    totals,
    latency: { p50: percentile(0.5), p95: percentile(0.95) },
    endpointRows: endpoints,
    networkRows: networks,
    bucketRows: buckets,
    bucketGranularity: bounds.granularity,
    coverage: {
      segments: [
        {
          source: "lakehouse",
          start: totals.observed_from,
          end: totals.observed_at,
        },
      ],
      latency: { start: totals.observed_from, end: totals.observed_at },
    },
  });
}

test("published real-Parquet chunks match expanded SQLite weights, boundaries and exact percentiles", async () => {
  for (const window of ["7d", "30d"])
    for (const until of [null, now, now - 4 * DAY + 1, now - 30 * DAY]) {
      const s = store();
      assert.deepEqual(
        await loadRpcUsageColdTier(s.env, { window, now, until }),
        reference(window, until),
      );
      const selected = s.manifest.chunks.filter(
        (c: { first: number; last: number }) =>
          c.last >= windowCutoffMs(window, now)!.cutoff &&
          (until === null || c.first < until),
      );
      assert.equal(s.get.mock.calls.length, selected.length + 2);
    }
}, 30_000);

test("unpublished ownership is absent; invalid selected proofs decline without SQL", async () => {
  assert.equal(
    await readNativeRpcRows(null, 0, null, now, () => {}),
    undefined,
  );
  const absent = store();
  absent.objects.clear();
  assert.equal(
    await readNativeRpcRows(absent.env, 0, null, now, () => {}),
    undefined,
  );
  const cases: ((s: ReturnType<typeof store>) => void)[] = [
    (s) => (s.objects.get(`${root}/current.json`)!.size = 0),
    (s) => (s.objects.get(`${root}/current.json`)!.size = 1024 * 1024 + 1),
    (s) => (s.manifest.version = 2),
    (s) => (s.manifest.generatedAt = now + 1),
    (s) => (s.manifest.generatedAt = now - 3 * DAY),
    (s) => s.manifest.retainedFrom++,
    (s) => (s.manifest.sourceRows = 0),
    (s) => s.manifest.sourceRows++,
    (s) => s.manifest.rowCount++,
    (s) => {
      s.manifest.source.sources.push(s.manifest.source.sources[0]);
      s.manifest.sourceRows *= 2;
    },
    (s) => s.objects.delete(`${root}/${s.manifest.generation}/manifest.json`),
    (s) =>
      s.objects.get(`${root}/${s.manifest.generation}/manifest.json`)!.size++,
    (s) =>
      s.put(`${root}/${s.manifest.generation}/manifest.json`, {
        ...s.manifest,
        table: "invalid",
      }),
    (s) => (s.manifest.chunks[0].object.key = "outside.json.gz"),
    (s) => (s.manifest.chunks[0].first = 0),
    (s) => (s.manifest.chunks[0].first = s.manifest.chunks[0].last + 1),
    (s) => (s.manifest.chunks[0].last = now + 2 * DAY),
    (s) => (s.manifest.chunks[0].last += DAY),
  ];
  for (const mutate of cases) {
    const s = store();
    mutate(s);
    if (![cases[0], cases[1], cases[10], cases[11], cases[12]].includes(mutate))
      s.publish();
    assert.equal(
      await loadRpcUsageColdTier(s.env, { window: "30d", now }),
      null,
    );
  }
  assert.equal(
    await readNativeRpcRows(store().env, 0, null, now, () => {}),
    false,
  );
});

test("chunk identities, compressed lengths, physical counts and data validation are enforced", async () => {
  const mutations: ((
    s: ReturnType<typeof store>,
    c: {
      object: { key: string; etag: string; bytes: number };
      rows: number;
      rawBytes: number;
      first: number;
      last: number;
    },
    item: { body: string; etag: string; size: number },
  ) => void)[] = [
    (s, c) => s.objects.delete(c.object.key),
    (_s, _c, o) => (o.etag = "changed"),
    (_s, _c, o) => o.size++,
    (_s, c) => c.rawBytes--,
    (_s, c) => c.rawBytes++,
    (s, c) => {
      c.rows--;
      s.manifest.rowCount--;
    },
    (_s, c) => c.first--,
    (_s, c) => c.last++,
    (_s, _c, o) => {
      o.body = Buffer.from("bad gzip").toString("base64");
    },
    (_s, c, o) => {
      const raw = Buffer.from(
        JSON.stringify([[now, null, null, null, true, 1, 2, null, 0]]),
      );
      const gz = gzipSync(raw);
      o.body = gz.toString("base64");
      o.size = c.object.bytes = gz.length;
      c.rawBytes = raw.length;
    },
  ];
  for (const mutate of mutations) {
    const s = store(),
      c = s.manifest.chunks.at(-1),
      o = s.objects.get(c.object.key)!;
    mutate(s, c, o);
    s.publish();
    assert.equal(
      await readNativeRpcRows(s.env, now - 30 * DAY, null, now, () => {}),
      false,
    );
  }
  const s = store();
  s.get.mockRejectedValue(new Error("offline"));
  assert.equal(
    await readNativeRpcRows(s.env, now - 30 * DAY, null, now, () => {}),
    false,
  );
});

test("percentile interpolation spans weighted runs and preserves empty latency", () => {
  assert.equal(rpcWeightedPercentile(new Map(), 0.5), null);
  assert.equal(
    rpcWeightedPercentile(
      new Map([
        [10, 1],
        [30, 1],
      ]),
      0.5,
    ),
    20,
  );
  assert.equal(
    rpcWeightedPercentile(
      new Map([
        [10, 2],
        [30, 2],
      ]),
      0.95,
    ),
    30,
  );
  assert.throws(
    () =>
      rpcWeightedPercentile(
        new Map([
          [10, 1],
          [20, 1],
        ]),
        2,
      ),
    /inconsistent/,
  );
});

test("preflights cumulative request and byte budgets before reading any chunk", async () => {
  for (const kind of ["requests", "stored", "decoded"]) {
    const s = store(),
      c = structuredClone(s.manifest.chunks.at(-1));
    const count = kind === "requests" ? 1025 : kind === "stored" ? 33 : 257;
    if (kind === "stored") c.object.bytes = 2 * 1024 * 1024;
    if (kind === "decoded") c.rawBytes = 2 * 1024 * 1024;
    s.manifest.chunks = Array.from({ length: count }, () => structuredClone(c));
    s.manifest.rowCount = count * c.rows;
    s.manifest.sourceRows = s.manifest.rowCount;
    s.manifest.source.sources[0].rows = s.manifest.rowCount;
    s.publish();
    assert.equal(
      await readNativeRpcRows(s.env, now - 7 * DAY, null, now, () => {}),
      false,
    );
    assert.equal(s.get.mock.calls.length, 2);
  }
});

test("numeric overflow and excessive latency populations decline the complete answer", async () => {
  const s = store(),
    c = s.manifest.chunks.at(-1),
    item = s.objects.get(c.object.key)!;
  const raw = Buffer.from(
    JSON.stringify([
      [now, "n", "e", "p", true, 1, Number.MAX_SAFE_INTEGER, "hit", 1000000],
    ]),
  );
  const gz = gzipSync(raw);
  item.body = gz.toString("base64");
  item.size = c.object.bytes = gz.length;
  c.rawBytes = raw.length;
  s.manifest.chunks = [c];
  c.rows = 1;
  c.first = c.last = now;
  s.manifest.rowCount = 1;
  s.publish();
  assert.equal(
    await loadRpcUsageColdTier(s.env, {
      now,
      until: now + 1,
    }),
    null,
  );
});

test("complete but excessive endpoint and latency cardinalities cannot publish partial aggregates", async () => {
  for (const kind of ["endpoints", "latencies"]) {
    const s = store(),
      original = s.manifest.chunks.at(-1);
    s.manifest.chunks = [];
    const count = kind === "endpoints" ? 65537 : 100001;
    for (let start = 0; start < count; start += 8192) {
      const rows = Array.from(
        { length: Math.min(8192, count - start) },
        (_, j) => [
          now,
          "n",
          kind === "endpoints" ? String(start + j) : "one",
          "p",
          true,
          1,
          kind === "latencies" ? start + j : 1,
          "hit",
          null,
        ],
      );
      const raw = Buffer.from(JSON.stringify(rows)),
        gz = gzipSync(raw),
        key = `${root}/chunks/${start.toString(16).padStart(64, "0")}.json.gz`;
      s.objects.set(key, {
        body: gz.toString("base64"),
        etag: "fixture",
        size: gz.length,
      });
      s.manifest.chunks.push({
        ...original,
        object: { key, etag: "fixture", bytes: gz.length },
        rows: rows.length,
        rawBytes: raw.length,
        first: now,
        last: now,
      });
    }
    s.manifest.rowCount = count;
    s.manifest.sourceRows = count;
    s.manifest.source.sources[0].rows = count;
    s.publish();
    assert.equal(
      await loadRpcUsageColdTier(s.env, {
        now,
        until: now + 1,
      }),
      null,
    );
  }
});

test("daily aggregates preserve exact results while avoiding full interior-day rows", async () => {
  const s = store();
  const answer = await loadRpcUsageColdTier(s.env, { window: "30d", now });
  assert.ok(answer);
  const keys = s.get.mock.calls.map(([key]) => key);
  assert.ok(keys.some((key) => key.includes("/days/")));
  const bodyKeys = keys.filter((key) => key.endsWith(".gz"));
  const picked = bodyKeys.reduce((n, key) => n + s.objects.get(key)!.size, 0);
  const raw = s.manifest.chunks
    .filter((c: { last: number }) => c.last >= now - 30 * DAY)
    .reduce(
      (n: number, c: { object: { bytes: number } }) => n + c.object.bytes,
      0,
    );
  assert.ok(picked < raw, `optimized ${picked} raw ${raw}`);
});

test("daily payload validation rejects inconsistent totals and time or latency distributions", async () => {
  const changes: ((value: Record<string, unknown>) => void)[] = [
    (v) => (v.day = 0),
    (v) => (v.rows = 0),
    (v) => (v.first = 0),
    (v) => (v.last = 0),
    (v) => ((v.totals as number[])[0] = 0),
    (v) => ((v.totals as number[])[1] = 1e12),
    (v) => (v.failover = 1e12),
    (v) => (v.cacheHits = 1e12),
    (v) => ((v.totals as number[])[3] = 1e12),
    (v) => (v.endpoints as number[][])[0][3]++,
    (v) => (v.hours as number[][])[0][1]++,
    (v) => (v.hours as number[][])[0][0]++,
    (v) => ((v.hours as number[][])[0][0] += DAY),
    (v) => (v.latencies as number[][])[0][1]++,
    (v) => (v.latencies as number[][])[0][0]++,
  ];
  for (const change of changes) {
    const s = store(),
      d = s.manifest.days.at(-2),
      item = s.objects.get(d.object.key)!;
    const value = JSON.parse(
      gunzipSync(Buffer.from(item.body, "base64")).toString(),
    );
    change(value);
    const raw = Buffer.from(JSON.stringify(value)),
      gz = gzipSync(raw);
    item.body = gz.toString("base64");
    item.size = d.object.bytes = gz.length;
    d.rawBytes = raw.length;
    s.publish();
    assert.equal(
      await loadRpcUsageColdTier(s.env, {
        window: "30d",
        now,
      }),
      null,
    );
  }
  const empty = store();
  empty.manifest.chunks = [];
  empty.manifest.rowCount = 0;
  empty.publish();
  assert.equal(await loadRpcUsageColdTier(empty.env, { now }), null);
});

test("daily descriptors require complete matching physical censuses", async () => {
  for (const mode of ["missing", "scope"]) {
    const s = store();
    if (mode === "missing") s.manifest.days.pop();
    else s.manifest.days[0].rows++;
    s.put(`${root}/current.json`, s.manifest);
    s.put(`${root}/${s.manifest.generation}/manifest.json`, s.manifest);
    assert.equal(
      await readNativeRpcRows(s.env, now - 30 * DAY, null, now, () => {}),
      false,
    );
  }
});

test("combined daily aggregates enforce numeric and cardinality budgets across days", async () => {
  for (const mode of ["numeric", "endpoints", "latencies"]) {
    const s = store(),
      template = structuredClone(s.manifest.chunks[0]);
    s.manifest.chunks = [];
    s.manifest.days = [];
    for (let i = 0; i < 2; i++) {
      const day = Math.floor(now / DAY) - 2 + i,
        ts = day * DAY;
      const n =
        i === 1 || mode === "numeric"
          ? 1
          : mode === "endpoints"
            ? 65536
            : 100000;
      const val =
        mode === "numeric" ? (i === 0 ? Number.MAX_SAFE_INTEGER - 1 : 3) : 1;
      const latencies =
        mode === "latencies"
          ? Array.from({ length: n }, (_, j) => [i === 0 ? j : 100000, 1])
          : [[val, n]];
      const sum = latencies.reduce((x, [v, w]) => x + v * w, 0),
        stats = [n, n, sum, n];
      const endpoints =
        mode === "endpoints"
          ? Array.from({ length: n }, (_, j) => [
              "n",
              i === 0 ? String(j) : "last",
              "p",
              1,
              1,
              val,
              1,
            ])
          : [["n", "one", "p", ...stats]];
      const payload = {
        day,
        rows: n,
        first: ts,
        last: ts,
        totals: stats,
        failover: 0,
        cacheHits: 0,
        endpoints,
        hours: [[ts, ...stats]],
        latencies,
      };
      const raw = Buffer.from(JSON.stringify(payload)),
        gz = gzipSync(raw),
        key = `${root}/days/${i.toString(16).padStart(64, "0")}.json.gz`;
      s.objects.set(key, {
        body: gz.toString("base64"),
        etag: "fixture",
        size: gz.length,
      });
      s.manifest.days.push({
        day,
        rows: n,
        first: ts,
        last: ts,
        object: { key, etag: "fixture", bytes: gz.length },
        rawBytes: raw.length,
      });
      for (let left = n; left > 0; left -= 8192)
        s.manifest.chunks.push({
          ...template,
          rows: Math.min(left, 8192),
          first: ts,
          last: ts,
        });
    }
    s.manifest.rowCount = s.manifest.days.reduce(
      (n: number, d: { rows: number }) => n + d.rows,
      0,
    );
    s.manifest.sourceRows = s.manifest.rowCount;
    s.manifest.source.sources[0].rows = s.manifest.rowCount;
    s.publish();
    assert.equal(
      await loadRpcUsageColdTier(s.env, { window: "30d", now }),
      null,
    );
  }
});

// A configured legacy credential must never revive the retired network reader.
const noWarehouse = vi.fn(async () => {
  throw Error("Unexpected network SQL");
});
beforeEach(() => {
  noWarehouse.mockClear();
  vi.stubGlobal("fetch", noWarehouse);
});
afterEach(() => {
  try {
    assert.equal(noWarehouse.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});
