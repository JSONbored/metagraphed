import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, test, vi } from "vitest";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import { runRawCaptureSync } from "../src/raw-capture-sync.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
const key = (testnet = false) =>
  `chain/raw/${testnet ? "testnet/" : ""}blocks/000000000010-000000000010.ndjson`;
const value = (at = 1000, extrinsics = ["0x00"]) =>
  JSON.stringify({
    block_number: 10,
    block_hash: "0x123",
    parent_hash: "0x122",
    header: { digest: { logs: [] } },
    extrinsics,
    events: null,
    captured_at: at,
  }) + "\n";
const publicationMigration = readFileSync(
  new URL(
    "../migrations/d1/0038_raw_capture_publications.sql",
    import.meta.url,
  ),
  "utf8",
);
function fixture() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0028_raw_capture_storage.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0029_raw_capture_archive.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(publicationMigration);
  let fail: ((text: string, params: unknown[]) => void) | undefined;
  let afterWrite:
    | ((text: string, params: unknown[]) => void | Promise<void>)
    | undefined;
  let readback: ((text: string, result: unknown) => unknown) | undefined;
  const prepared = (text: string, params: unknown[] = []) => ({
    text,
    params,
    bind(...next: unknown[]) {
      return prepared(
        text,
        next.map((value) =>
          value instanceof ArrayBuffer ? Buffer.from(value) : value,
        ),
      );
    },
    async first() {
      fail?.(text, params);
      const result = sql.prepare(text).get(...(params as never[])) ?? null;
      return readback ? readback(text, result) : result;
    },
    async run() {
      fail?.(text, params);
      sql.prepare(text).run(...(params as never[]));
      await afterWrite?.(text, params);
      return { success: true };
    },
    async all() {
      fail?.(text, params);
      const result = sql.prepare(text).all(...(params as never[]));
      return {
        success: true,
        results: readback ? readback(text, result) : result,
      };
    },
  });
  const db = {
    prepare: prepared,
    async batch(statements: ReturnType<typeof prepared>[]) {
      sql.exec("BEGIN");
      let result;
      try {
        result = statements.map(({ text, params }) => {
          fail?.(text, params);
          return {
            success: true,
            results: sql.prepare(text).all(...(params as never[])),
          };
        });
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
      await afterWrite?.(
        statements.map(({ text }) => text).join("\n"),
        statements.flatMap(({ params }) => params),
      );
      return result;
    },
  } as unknown as Pick<D1Database, "prepare" | "batch">;
  const selected = (objectKey = key()) =>
    sql
      .prepare("SELECT sha256 FROM raw_capture_selected WHERE key=?")
      .get(objectKey)?.sha256;
  return {
    sql,
    db,
    store: rawCaptureD1(db),
    selected,
    failWith(fn?: typeof fail) {
      fail = fn;
    },
    failAfterWriteWith(fn?: typeof fail) {
      afterWrite = fn;
    },
    readWith(fn?: typeof readback) {
      readback = fn;
    },
  };
}

function archive(f: ReturnType<typeof fixture>, objectKey = key()) {
  const row = f.sql
    .prepare(
      "SELECT b.* FROM raw_capture_batches b JOIN raw_capture_selected s USING(key,sha256) WHERE b.key=?",
    )
    .get(objectKey)!;
  const nativeKey = `chain/raw/native/v1/${row.network}/${row.sha256}/${row.compressed_sha256}.gz`;
  f.sql
    .prepare(
      "INSERT INTO raw_capture_archives SELECT b.*,1,?,?,compressed_sha256 FROM raw_capture_batches b WHERE b.key=? AND b.sha256=?",
    )
    .run(nativeKey, "a".repeat(32), objectKey, row.sha256!);
  return row;
}

const transientStorageErrors = [
  "D1_ERROR: Network connection lost.",
  "Network connection lost.",
  "D1_ERROR: Replica disconnected from primary.",
  "D1_ERROR: D1 DB reset because its code was updated.",
  "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
  "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
  "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.",
  "D1_ERROR: internal error; reference = e_Gz3hrU_b7228883de2448ffa0730ff0aa3ce9d7",
];

test.each(
  [
    "SELECT * FROM raw_capture_archives",
    "INSERT INTO raw_capture_batches",
    "SELECT key,sha256,network",
    "INSERT INTO raw_capture_chunks",
    "SELECT part,hex(data)",
    "UPDATE raw_capture_batches",
    "INSERT INTO raw_capture_publications",
    "SELECT sha256 FROM (",
  ].flatMap((phase) => transientStorageErrors.map((error) => [phase, error])),
)(
  "one storage failure at %s retries the same exact capture: %s",
  async (phase, error) => {
    vi.useFakeTimers();
    const f = fixture();
    let calls = 0;
    f.failWith((text) => {
      if (text.startsWith(phase) && ++calls === 1) throw new Error(error);
    });
    const pending = f.store.put(key(), value());
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(calls, 2);
    assert.equal(
      f.selected(),
      createHash("sha256").update(value()).digest("hex"),
    );
    assert.equal(
      f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
      1,
    );
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM raw_capture_chunks").get()?.n,
      1,
    );
  },
);

test.each(
  [
    "INSERT INTO raw_capture_batches",
    "INSERT INTO raw_capture_chunks",
    "UPDATE raw_capture_batches",
  ].flatMap((phase) => transientStorageErrors.map((error) => [phase, error])),
)(
  "a lost committed %s reply does not duplicate bytes or reservation: %s",
  async (phase, error) => {
    vi.useFakeTimers();
    const f = fixture();
    let calls = 0;
    f.failAfterWriteWith((text) => {
      if (text.startsWith(phase) && ++calls === 1) throw new Error(error);
    });
    const pending = f.store.put(key(), value());
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(calls, 2);
    assert.equal(
      f.selected(),
      createHash("sha256").update(value()).digest("hex"),
    );
    assert.equal(
      f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
      1,
    );
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM raw_capture_chunks").get()?.n,
      1,
    );
  },
);

test.each(transientStorageErrors)(
  "an archived capture acknowledgement can recover %s",
  async (error) => {
    const f = fixture();
    await f.store.put(key(), value());
    archive(f);
    vi.useFakeTimers();
    let calls = 0;
    f.failWith((text) => {
      if (text.startsWith("SELECT sha256 FROM (") && ++calls === 1)
        throw new Error(error);
    });
    const pending = f.store.put(key(), value());
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(calls, 2);
    assert.equal(
      f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
      0,
    );
  },
);

test("the single retry budget is shared across storage operations and error types", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let failedReservation = false,
    failedChunk = false;
  f.failWith((text) => {
    if (
      text.startsWith("INSERT INTO raw_capture_batches") &&
      !failedReservation
    ) {
      failedReservation = true;
      throw new Error("D1_ERROR: internal error; reference = e_provider_reset");
    }
    if (text.startsWith("INSERT INTO raw_capture_chunks")) {
      failedChunk = true;
      throw new Error("D1_ERROR: Network connection lost.");
    }
  });
  const rejected = assert.rejects(
    f.store.put(key(), value()),
    /Network connection lost/,
  );
  await vi.runAllTimersAsync();
  await rejected;
  assert(failedReservation && failedChunk);
  assert.equal(f.selected(), undefined);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_chunks").get()?.n,
    0,
  );
});

test.each([
  ...transientStorageErrors.map((message) => new Error(message)),
  new Error("D1_ERROR: overloaded"),
  new Error("D1_ERROR: internal error"),
  new Error("D1_ERROR: internal error; reference = "),
  new Error("D1_ERROR: internal error; reference = e_reset; exceeded capacity"),
  new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."),
  new Error("Raw capture reservation readback differs"),
  "D1_ERROR: Network connection lost.",
])(
  "persistent and non-transient failures cannot acknowledge partial capture: %s",
  async (error) => {
    vi.useFakeTimers();
    const f = fixture();
    let calls = 0;
    f.failWith((text) => {
      if (text.startsWith("INSERT INTO raw_capture_batches")) {
        calls++;
        throw error;
      }
    });
    const rejected = assert.rejects(
      f.store.put(key(), value()),
      (actual) => actual === error,
    );
    await vi.runAllTimersAsync();
    await rejected;
    assert.equal(
      calls,
      error instanceof Error && transientStorageErrors.includes(error.message)
        ? 2
        : 1,
    );
    assert.equal(f.selected(), undefined);
    assert.equal(
      f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
      0,
    );
  },
);

test("archiving atomically releases staging capacity and a lost capture acknowledgement remains retryable", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const row = archive(f);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_chunks").get()?.n,
    0,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_batches").get()?.n,
    0,
  );
  assert.equal(
    f.sql.prepare("SELECT bytes FROM raw_capture_budget").get()?.bytes,
    0,
  );
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    0,
  );
  await f.store.put(key(), value());
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_batches").get()?.n,
    0,
  );
  assert.equal(
    f.sql
      .prepare("SELECT sha256 FROM raw_capture_archives WHERE selected=1")
      .get()?.sha256,
    row.sha256,
  );
});

test("archiving between selection and acknowledgement still confirms the exact capture", async () => {
  const f = fixture();
  let archived = false;
  f.failWith((text) => {
    if (text.startsWith("SELECT sha256 FROM (")) {
      archive(f);
      archived = true;
    }
  });
  await f.store.put(key(), value());
  assert(archived);
  assert.equal(f.selected(), undefined);
  assert.equal(
    f.sql.prepare("SELECT bytes FROM raw_capture_budget").get()?.bytes,
    0,
  );
});

test("an older capture cannot displace an archived selection and newer captures retain old history", async () => {
  const f = fixture();
  await f.store.put(key(), value(2000));
  const old = archive(f);
  await assert.rejects(f.store.put(key(), value(1000)), /selection/);
  await f.store.put(key(), value(3000));
  const current = archive(f);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_archives").get()?.n,
    2,
  );
  assert.equal(
    f.sql
      .prepare("SELECT selected FROM raw_capture_archives WHERE sha256=?")
      .get(old.sha256!)?.selected,
    0,
  );
  assert.equal(
    f.sql
      .prepare("SELECT selected FROM raw_capture_archives WHERE sha256=?")
      .get(current.sha256!)?.selected,
    1,
  );
  // This version really was published. Its receipt survives a newer archive.
  await f.store.put(key(), value(2000));
  assert.equal(
    f.sql
      .prepare("SELECT sha256 FROM raw_capture_archives WHERE selected=1")
      .get()?.sha256,
    current.sha256,
  );
});

test.each([false, true])(
  "overlapping committed writers acknowledge their own exact publication: testnet=%s",
  async (testnet) => {
    const f = fixture();
    const objectKey = key(testnet);
    const first = value(1000),
      second = value(1049);
    let overlapped = false;
    f.failAfterWriteWith(async (text) => {
      if (!text.startsWith("UPDATE raw_capture_batches")) return;
      f.failAfterWriteWith();
      await f.store.put(objectKey, second);
      overlapped = true;
    });
    await f.store.put(objectKey, first);
    assert(overlapped);
    assert.equal(
      f.selected(objectKey),
      createHash("sha256").update(second).digest("hex"),
    );
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM raw_capture_publications").get()?.n,
      2,
    );
    const originals = f.sql
      .prepare(
        "SELECT b.sha256,c.data FROM raw_capture_batches b JOIN raw_capture_chunks c USING(key,sha256) WHERE b.key=? ORDER BY b.captured_at,c.part",
      )
      .all(objectKey);
    assert.equal(originals.length, 2);
    assert.deepEqual(
      originals.map((row) => gunzipSync(row.data as Uint8Array).toString()),
      [first, second],
    );
  },
);

test("a lost committed reply remains retryable after a newer writer and archival", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const first = value(1000),
    second = value(1089);
  let lost = false;
  f.failAfterWriteWith(async (text) => {
    if (!text.startsWith("UPDATE raw_capture_batches")) return;
    f.failAfterWriteWith();
    await f.store.put(key(), second);
    archive(f);
    // The superseded original is also independently archived, selected=0.
    f.sql
      .prepare(
        "INSERT INTO raw_capture_archives SELECT b.*,0,?, ?,compressed_sha256 FROM raw_capture_batches b WHERE b.key=?",
      )
      .run(
        `chain/raw/native/v1/mainnet/${createHash("sha256").update(first).digest("hex")}/${f.sql.prepare("SELECT compressed_sha256 FROM raw_capture_batches WHERE key=?").get(key())!.compressed_sha256}.gz`,
        "b".repeat(32),
        key(),
      );
    lost = true;
    throw new Error("D1_ERROR: Network connection lost.");
  });
  const pending = f.store.put(key(), first);
  await vi.runAllTimersAsync();
  await pending;
  assert(lost);
  await f.store.put(key(), first);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_publications").get()?.n,
    2,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_archives").get()?.n,
    2,
  );
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    0,
  );
  assert.equal(
    f.sql
      .prepare("SELECT sha256 FROM raw_capture_archives WHERE selected=1")
      .get()?.sha256,
    createHash("sha256").update(second).digest("hex"),
  );
});

test("publication receipt failure rolls completion and selection back together", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const prior = f.selected();
  f.sql.exec(
    "CREATE TRIGGER reject_publication BEFORE INSERT ON raw_capture_publications BEGIN SELECT RAISE(ABORT,'publication failed'); END",
  );
  await assert.rejects(f.store.put(key(), value(2000)), /publication failed/);
  assert.equal(f.selected(), prior);
  assert.equal(
    f.sql
      .prepare(
        "SELECT complete FROM raw_capture_batches WHERE captured_at=2000",
      )
      .get()?.complete,
    0,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_publications").get()?.n,
    1,
  );
  f.sql.exec("DROP TRIGGER reject_publication");
  await f.store.put(key(), value(2000));
  assert.notEqual(f.selected(), prior);
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    2,
  );
});

test("complete but never selected conflicting data has no publication receipt", async () => {
  const f = fixture();
  await f.store.put(key(), value(2000));
  const prior = f.selected();
  await assert.rejects(
    f.store.put(key(), value(1000, ["0xffff"])),
    /selection was not acknowledged/,
  );
  assert.equal(f.selected(), prior);
  assert.equal(
    f.sql
      .prepare(
        "SELECT complete FROM raw_capture_batches WHERE captured_at=1000",
      )
      .get()?.complete,
    1,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_publications").get()?.n,
    1,
  );
});

test.each([null, { sha256: "f".repeat(64) }])(
  "missing or wrong publication receipts remain fatal: %s",
  async (receipt) => {
    const f = fixture();
    f.readWith((text, result) =>
      text.startsWith("SELECT sha256 FROM (") ? receipt : result,
    );
    await assert.rejects(
      f.store.put(key(), value()),
      /selection was not acknowledged/,
    );
  },
);

test.each([false, true])(
  "migration attests only the existing complete current selection: archived=%s",
  async (archived) => {
    const f = fixture();
    await f.store.put(key(), value(1000));
    if (archived) archive(f);
    await f.store.put(key(), value(2000));
    if (archived) archive(f);
    f.sql.exec("DROP TABLE raw_capture_publications");
    f.sql.exec(publicationMigration);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM raw_capture_publications").get()?.n,
      1,
    );
    await f.store.put(key(), value(2000));
    await assert.rejects(
      f.store.put(key(), value(1000)),
      /selection was not acknowledged/,
    );
  },
);

test("a retained receipt without complete source bytes cannot acknowledge publication", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const prior = f.selected();
  f.sql.exec(
    "UPDATE raw_capture_batches SET complete=0; DELETE FROM raw_capture_selected;",
  );
  f.failWith((text) => {
    if (text.startsWith("UPDATE raw_capture_batches")) {
      // Make completion's guarded census fail after source-byte readback.
      f.sql.exec("DELETE FROM raw_capture_chunks");
    }
  });
  await assert.rejects(
    f.store.put(key(), value()),
    /selection was not acknowledged/,
  );
  assert(prior);
  assert.equal(f.selected(), undefined);
});

test("an archive with changed source metadata cannot release staging bytes", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const before = f.sql.prepare("SELECT * FROM raw_capture_budget").get();
  assert.throws(
    () =>
      f.sql
        .prepare(
          "INSERT INTO raw_capture_archives SELECT key,sha256,network,first_block,last_block,raw_bytes+1,compressed_bytes,compressed_sha256,parts,captured_at,complete,1,'bad',?,compressed_sha256 FROM raw_capture_batches",
        )
        .run("a".repeat(32)),
    /source changed/,
  );
  assert.deepEqual(
    f.sql.prepare("SELECT * FROM raw_capture_budget").get(),
    before,
  );
  assert(f.selected());
});

test("both networks reconstruct exact raw bytes and null events through the real schema", async () => {
  const f = fixture(),
    raw = value();
  for (const testnet of [false, true]) {
    await f.store.put(key(testnet), raw);
    const rows = f.sql
      .prepare(
        "SELECT c.data FROM raw_capture_selected s JOIN raw_capture_chunks c USING(key,sha256) WHERE s.key=? ORDER BY c.part",
      )
      .all(key(testnet)) as { data: Uint8Array }[];
    assert.equal(
      gunzipSync(
        Buffer.concat(rows.map((r) => Buffer.from(r.data))),
      ).toString(),
      raw,
    );
    assert.equal(
      f.selected(key(testnet)),
      createHash("sha256").update(raw).digest("hex"),
    );
  }
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    2,
  );
});

test("chunking stays bounded and retries reuse existing immutable storage", async () => {
  const f = fixture(),
    raw = value(1000, [randomBytes(180_000).toString("hex")]);
  await f.store.put(key(), raw);
  await f.store.put(key(), raw);
  const chunks = f.sql
    .prepare(
      "SELECT count(*) n, max(length(data)) bytes FROM raw_capture_chunks",
    )
    .get()!;
  assert(Number(chunks.n) > 1);
  assert(Number(chunks.bytes) <= 65_536);
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    1,
  );
});

test("a partial write or corrupt readback never replaces the prior selected capture", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const prior = f.selected();
  f.failWith((text) => {
    if (text.startsWith("INSERT INTO raw_capture_chunks"))
      throw new Error("lost connection");
  });
  await assert.rejects(f.store.put(key(), value(2000)));
  assert.equal(f.selected(), prior);
  f.failWith();
  const digest = createHash("sha256").update(value(2000)).digest("hex");
  f.sql
    .prepare("INSERT INTO raw_capture_chunks VALUES(?,?,0,?)")
    .run(key(), digest, Buffer.from("corrupt"));
  await assert.rejects(f.store.put(key(), value(2000)), /readback differs/);
  assert.equal(f.selected(), prior);
});

test("lost selection acknowledgement can be retried without duplicate reservations", async () => {
  const f = fixture();
  f.failWith((text) => {
    if (text.startsWith("SELECT sha256 FROM ("))
      throw new Error("lost acknowledgement");
  });
  await assert.rejects(f.store.put(key(), value()));
  assert(f.selected());
  f.failWith();
  await f.store.put(key(), value());
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    1,
  );
});

test("older capture invocations cannot replace newer selected data", async () => {
  const f = fixture();
  await f.store.put(key(), value(2000));
  const prior = f.selected();
  await assert.rejects(
    f.store.put(key(), value(1000)),
    /selection was not acknowledged/,
  );
  assert.equal(f.selected(), prior);
});

test("a full staging budget rejects new bytes before any incomplete selection", async () => {
  const f = fixture();
  f.sql.exec("UPDATE raw_capture_budget SET bytes=536870912");
  await assert.rejects(f.store.put(key(), value()), /CHECK constraint/);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_batches").get()?.n,
    0,
  );
  assert.equal(f.selected(), undefined);
});

test("invalid ranges and cross-network key spellings fail before reserving space", async () => {
  const f = fixture();
  for (const [objectKey, raw] of [
    [key().replace("000000000010.ndjson", "000000000009.ndjson"), value()],
    [key().replace("000000000010.ndjson", "000000004106.ndjson"), value()],
    [key().replace("000000000010.ndjson", "000000000011.ndjson"), value()],
    [key().replace("chain/raw/", "chain/testnet/raw/"), value()],
    [key(), value().replace('"block_number":10', '"block_number":11')],
  ])
    await assert.rejects(f.store.put(objectKey!, raw!));
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    0,
  );
});

test("missing or mismatched reservation responses cannot publish a capture", async () => {
  for (const reservation of [null, { raw_bytes: 0 }]) {
    const f = fixture();
    f.readWith((text, result) =>
      text.startsWith("SELECT key,sha256,network") ? reservation : result,
    );
    await assert.rejects(
      f.store.put(key(), value()),
      /reservation readback differs/,
    );
    assert.equal(f.selected(), undefined);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM raw_capture_chunks").get()?.n,
      0,
    );
  }
});

test("an incomplete chunk response leaves the prior capture selected and retries safely", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const prior = f.selected();
  f.readWith((text, result) =>
    text.startsWith("SELECT part,hex(data)") ? [] : result,
  );
  await assert.rejects(f.store.put(key(), value(2000)), /chunk census differs/);
  assert.equal(f.selected(), prior);
  f.readWith();
  await f.store.put(key(), value(2000));
  assert.notEqual(f.selected(), prior);
});

test("corrupt archive receipts cannot acknowledge a raw capture", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  archive(f);
  f.readWith((text, result) =>
    text.startsWith("SELECT * FROM raw_capture_archives")
      ? { ...(result as object), native_sha256: "bad" }
      : result,
  );
  await assert.rejects(f.store.put(key(), value()), /archive identity differs/);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_batches").get()?.n,
    0,
  );
});

test("missing, retired and unknown storage selections cannot resume capture writes", async () => {
  for (const storage of [undefined, "r2", "typo"]) {
    let writes = 0;
    const result = await runRawCaptureSync(
      {
        RAW_CAPTURE_ENABLED: "true",
        RAW_CAPTURE_STORAGE: storage,
        D1_STATE: { prepare: () => {} } as unknown as D1Database,
        METAGRAPH_ARCHIVE: {
          put: async () => {
            writes++;
          },
        },
      },
      {
        recordException: async () => false,
        d1CaptureStore: {
          put: async () => {
            writes++;
          },
        },
        fetchImpl: async () => {
          throw new Error("capture must refuse before RPC");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    assert.equal(result.reason, "store_unavailable");
  }
});

test("D1 selection with a missing database cannot fall through to an R2 writer", async () => {
  let writes = 0;
  const result = await runRawCaptureSync(
    {
      RAW_CAPTURE_ENABLED: "true",
      RAW_CAPTURE_STORAGE: "d1",
      METAGRAPH_ARCHIVE: {
        put: async () => {
          writes++;
        },
      },
    },
    { recordException: async () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});
