import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { neonWatermark } from "../src/raw-capture-sync.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const failures = { reads: false, writes: false };
let beforeRead: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of ["0006_raw_capture.sql", "0013_raw_capture_network.sql"]) {
    const migration = readFileSync(
      new URL(`./fixtures/sqlite-schema/${name}`, import.meta.url),
      "utf8",
    ).replace(/^\s*--.*$/gm, "");
    for (const statement of migration.split(";").filter((sql) => sql.trim()))
      await db.prepare(statement).run();
  }
});
beforeEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS decline_raw_frontier").run();
  await db.prepare("DELETE FROM raw_capture_state").run();
  failures.reads = false;
  failures.writes = false;
  beforeRead = undefined;
});
afterAll(async () => runtime.dispose());

// Forward the complete native statement contract; only the requested failure
// or readback barrier is injected. SQL, rows and metadata come from real D1.
class ControlledStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    readonly text: string,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    return new ControlledStatement(this.inner.bind(...values), this.text);
  }
  async gate(): Promise<void> {
    const reading = /^\s*SELECT/.test(this.text);
    if (reading && failures.reads) throw new Error("readback unavailable");
    if (!reading && failures.writes) throw new Error("write unavailable");
    if (reading && beforeRead) {
      const hook = beforeRead;
      beforeRead = undefined;
      await hook();
    }
  }
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    await this.gate();
    return colName === undefined
      ? this.inner.first<T>()
      : this.inner.first<T>(colName);
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.gate();
    return this.inner.run<T>();
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.gate();
    return this.inner.all<T>();
  }
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    await this.gate();
    return options?.columnNames
      ? this.inner.raw<T>({ columnNames: true })
      : this.inner.raw<T>();
  }
}

function store() {
  const controlled: D1Database = {
    prepare: (text) => new ControlledStatement(db.prepare(text), text),
    batch: (statements) =>
      db.batch(
        statements.map((statement) =>
          statement instanceof ControlledStatement
            ? statement.inner
            : statement,
        ),
      ),
    exec: (text) => db.exec(text),
    dump: () => db.dump(),
    withSession: (constraint) => db.withSession(constraint),
  };
  return neonWatermark(
    { D1_STATE_TABLES: "raw_capture_state", D1_STATE: controlled },
    undefined,
    "mainnet",
    () => 1000,
  );
}

test("native watermark refuses failed writes and resumes after store recovery", async () => {
  const watermark = store();
  failures.writes = true;
  await assert.rejects(watermark.write(43), /write was not acknowledged/);
  assert.equal(await watermark.read(), null);
  failures.writes = false;
  await watermark.write(43);
  assert.equal(await watermark.read(), 43);
  await watermark.write(42);
  assert.equal(
    await watermark.read(),
    43,
    "a newer writer's committed frontier is retained",
  );
});

test("SQL completion alone cannot acknowledge an absent frontier", async () => {
  // SQLite can complete a statement that a trigger declines. Execute the
  // production SQL, rather than mocking its promise as evidence of a row.
  await db
    .prepare(
      `CREATE TRIGGER decline_raw_frontier BEFORE INSERT ON raw_capture_state
    BEGIN SELECT RAISE(IGNORE); END`,
    )
    .run();
  const watermark = store();
  await assert.rejects(watermark.write(43), /was not committed/);
  assert.equal(await watermark.read(), null);
  await db.prepare("DROP TRIGGER decline_raw_frontier").run();
  await watermark.write(42);
  await db
    .prepare(
      `CREATE TRIGGER decline_raw_frontier BEFORE INSERT ON raw_capture_state
    BEGIN SELECT RAISE(IGNORE); END`,
    )
    .run();
  await assert.rejects(watermark.write(43), /was not committed/);
  assert.equal(await watermark.read(), 42);
  await db.prepare("DROP TRIGGER decline_raw_frontier").run();
  await watermark.write(43);
  assert.equal(await watermark.read(), 43);
});

test("an unreadable readback does not erase the committed row or report success", async () => {
  const watermark = store();
  failures.reads = true;
  await assert.rejects(watermark.write(43), /readback unavailable/);
  failures.reads = false;
  assert.equal(await watermark.read(), 43);
  await watermark.write(43);
});

test("an unbound watermark writer refuses acknowledgment", async () => {
  await assert.rejects(
    neonWatermark({}, undefined, "mainnet", () => 1000).write(43),
    /store is unbound/,
  );
});

test("an unsafe integer cannot certify a frontier", async () => {
  // SQLite can retain an integer outside JavaScript's exact integer range.
  await db
    .prepare(
      `INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at)
    VALUES ('mainnet',9007199254740992,1000)`,
    )
    .run();
  await assert.rejects(store().write(43), /was not committed/);
});

test("an overlapping writer may advance while an older write awaits readback", async () => {
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeRead = async () => {
    entered();
    await released;
  };
  const older = store().write(43);
  await reading;
  try {
    await store().write(44);
  } finally {
    release();
  }
  await older;
  assert.equal(await store().read(), 44);
});
