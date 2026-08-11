// The write-behind buffer (src/neon-write-buffer.ts).
//
// The properties worth asserting are the ones whose failure is SILENT:
//
//   * ORDERING. `storage.list()` sorts lexicographically, so an unpadded
//     sequence replays statement 10 before statement 9 and nothing throws.
//   * CHUNK REJOINING. A payload split by code unit rather than by byte cuts a
//     multi-byte character in half; the rejoin is corrupt, not absent.
//   * THE CEILING. A buffer that grows without bound turns a stalled flush into
//     an outage nobody can see.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  chunkKey,
  CHUNK_BYTES,
  createBufferedPgSql,
  decodeStatement,
  ENQUEUE_ATTEMPTS,
  DO_VALUE_LIMIT_BYTES,
  encodeStatement,
  FLUSH_INTERVAL_MS,
  groupChunkKeys,
  joinPayload,
  MAX_BUFFERED_PAYLOAD_BYTES,
  MAX_BUFFERED_STATEMENTS,
  payloadBytes,
  NEVER_BUFFER_LANES,
  neonWriteBufferEnabled,
  neonWriteBufferLanes,
  neonWriteRunner,
  seqFromChunkKey,
  shouldFlushEarly,
  splitPayload,
  STATEMENT_PREFIX,
  SEQ_WIDTH,
} from "../src/neon-write-buffer.ts";

describe("chunkKey", () => {
  test("pads so LEXICAL order is INSERTION order", () => {
    // The whole ordering guarantee. Unpadded, "stmt:10" < "stmt:9" and the
    // backlog replays out of order with nothing to notice it.
    const keys = [chunkKey(9, 0), chunkKey(10, 0), chunkKey(2, 0)];
    assert.deepEqual([...keys].sort(), [
      chunkKey(2, 0),
      chunkKey(9, 0),
      chunkKey(10, 0),
    ]);
  });

  test("pads the PART too, so part 10 cannot precede part 2", () => {
    const parts = [chunkKey(1, 2), chunkKey(1, 10)];
    assert.deepEqual([...parts].sort(), [chunkKey(1, 2), chunkKey(1, 10)]);
  });

  test("the width holds the largest safe integer without widening", () => {
    // If it ever needed a 17th digit the padding would stop working at a round
    // number, which is the worst possible time to discover it.
    assert.ok(String(Number.MAX_SAFE_INTEGER).length <= SEQ_WIDTH);
  });

  test("lives under the prefix the flush lists by", () => {
    assert.ok(chunkKey(1, 0).startsWith(STATEMENT_PREFIX));
  });
});

describe("seqFromChunkKey", () => {
  test("reads the sequence back out", () => {
    assert.equal(seqFromChunkKey(chunkKey(4321, 7)), 4321);
  });

  test("a key outside the prefix is not a statement", () => {
    assert.equal(seqFromChunkKey("seq"), null);
    assert.equal(seqFromChunkKey("other:0001"), null);
  });

  test("a non-numeric or negative sequence is refused", () => {
    assert.equal(seqFromChunkKey(`${STATEMENT_PREFIX}abc:0000`), null);
    assert.equal(seqFromChunkKey(`${STATEMENT_PREFIX}-1:0000`), null);
  });
});

describe("splitPayload / joinPayload", () => {
  test("round-trips a payload that needs no splitting", () => {
    const payload = JSON.stringify({ a: 1 });
    assert.equal(joinPayload(splitPayload(payload)), payload);
  });

  test("round-trips ACROSS a boundary that cuts a multi-byte character", () => {
    // The bug this is aimed at: "τ" is two bytes and appears in real subnet
    // names (see registry/subnets). Split by code unit at the wrong index and
    // each half is invalid UTF-8; split by byte and rejoin, and it is exact.
    const payload = "ττττττττ";
    const parts = splitPayload(payload, 3);
    assert.ok(parts.length > 1, "must actually split");
    assert.equal(joinPayload(parts), payload);
  });

  test("every chunk stays inside the platform's value limit", () => {
    const payload = "x".repeat(CHUNK_BYTES * 2 + 17);
    for (const part of splitPayload(payload)) {
      assert.ok(part.length <= CHUNK_BYTES);
      assert.ok(part.length <= DO_VALUE_LIMIT_BYTES);
    }
  });

  test("headroom is real -- the chunk size is under the platform cap", () => {
    assert.ok(CHUNK_BYTES < DO_VALUE_LIMIT_BYTES);
  });

  test("an empty payload is one empty chunk, not zero chunks", () => {
    // Zero chunks would make the statement invisible to groupChunkKeys and it
    // would never drain -- a row silently lost rather than a row rejected.
    assert.equal(splitPayload("").length, 1);
    assert.equal(joinPayload(splitPayload("")), "");
  });

  test("a chunk size of zero still makes progress", () => {
    // Guards the loop: a zero step would never advance the offset.
    assert.equal(joinPayload(splitPayload("abc", 0)), "abc");
  });
});

describe("encodeStatement / decodeStatement", () => {
  const statement = {
    lane: "blocks-head",
    text: "INSERT INTO blocks_head VALUES ($1)",
    values: [1, null, "τ"],
  };

  test("round-trips a statement verbatim", () => {
    assert.deepEqual(decodeStatement(encodeStatement(statement)), statement);
  });

  test("unparseable JSON decodes to null rather than throwing", () => {
    // The caller is a drain loop: one bad entry must cost that entry, never
    // the backlog behind it.
    assert.equal(decodeStatement("{not json"), null);
  });

  test("a non-object, a missing lane, text or values are all refused", () => {
    assert.equal(decodeStatement("42"), null);
    assert.equal(decodeStatement("null"), null);
    assert.equal(
      decodeStatement(JSON.stringify({ text: "x", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "", text: "x", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "", values: [] })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "x" })),
      null,
    );
    assert.equal(
      decodeStatement(JSON.stringify({ lane: "l", text: "x", values: "no" })),
      null,
    );
  });

  test("an empty values array is a VALID statement, not a missing one", () => {
    // A parameterless DELETE is an ordinary shape here. Treating [] as absent
    // would drop it.
    const bare = { lane: "l", text: "DELETE FROM t", values: [] };
    assert.deepEqual(decodeStatement(encodeStatement(bare)), bare);
  });
});

describe("groupChunkKeys", () => {
  test("groups parts by statement, in replay order", () => {
    const keys = [
      chunkKey(2, 0),
      chunkKey(10, 1),
      chunkKey(10, 0),
      chunkKey(1, 0),
    ];
    const groups = groupChunkKeys(keys);
    assert.deepEqual(
      groups.map((g) => g.seq),
      [1, 2, 10],
    );
    // And the parts within a statement are ordered too.
    assert.deepEqual(groups[2].keys, [chunkKey(10, 0), chunkKey(10, 1)]);
  });

  test("ignores keys that are not statements", () => {
    // `seq` lives in the same storage; counting it as a statement would make
    // the buffer look permanently non-empty.
    assert.deepEqual(groupChunkKeys(["seq", "other"]), []);
  });

  test("no keys is no statements", () => {
    assert.deepEqual(groupChunkKeys([]), []);
  });
});

describe("the flush bounds", () => {
  test("the interval clears the suspend timeout it exists to beat", () => {
    // 300s is the configured suspend_timeout_seconds. At or under it the
    // compute would never quite sleep, which is the entire point of the change.
    assert.ok(FLUSH_INTERVAL_MS > 300_000);
  });

  test("and stays well inside the two-hour freshness bound", () => {
    // src/table-freshness-watchdog.ts holds every buffered table to 2 * HOUR.
    assert.ok(FLUSH_INTERVAL_MS * 12 <= 2 * 60 * 60 * 1000);
  });

  test("the ceiling forces a flush rather than growing forever", () => {
    assert.equal(shouldFlushEarly(MAX_BUFFERED_STATEMENTS - 1), false);
    assert.equal(shouldFlushEarly(MAX_BUFFERED_STATEMENTS), true);
    assert.equal(shouldFlushEarly(3, 3), true);
  });
});

describe("neonWriteBufferLanes", () => {
  test("defaults to EMPTY, so the introducing deploy buffers nothing", () => {
    assert.equal(neonWriteBufferLanes({}).size, 0);
    assert.equal(neonWriteBufferLanes(null).size, 0);
    assert.equal(neonWriteBufferLanes({ NEON_WRITE_BUFFER_LANES: "" }).size, 0);
    assert.equal(neonWriteBufferLanes({ NEON_WRITE_BUFFER_LANES: 7 }).size, 0);
  });

  test("trims and drops empties, so a trailing comma is not a lane", () => {
    assert.deepEqual(
      [
        ...neonWriteBufferLanes({
          NEON_WRITE_BUFFER_LANES: " blocks-head , ,chain-detail ",
        }),
      ],
      ["blocks-head", "chain-detail"],
    );
  });

  test("enables exactly the lanes named", () => {
    const env = { NEON_WRITE_BUFFER_LANES: "neurons" };
    assert.equal(neonWriteBufferEnabled(env, "neurons"), true);
    assert.equal(neonWriteBufferEnabled(env, "nominator-positions"), false);
    assert.equal(neonWriteBufferEnabled({}, "neurons"), false);
  });
});

describe("neonWriteRunner", () => {
  const HD = { connectionString: "postgresql://x" };
  const CTX = { waitUntil: () => undefined };

  function namespace() {
    const sent: unknown[] = [];
    return {
      sent,
      ns: {
        idFromName: (n: string) => n,
        get: () => ({
          async fetch(request: Request) {
            sent.push(await request.json());
            return new Response("{}", { status: 200 });
          },
        }),
      },
    };
  }

  test("a flagged lane with the binding present returns the BUFFERED runner", async () => {
    const n = namespace();
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: n.ns, NEON_WRITE_BUFFER_LANES: "neurons" },
      CTX,
      "neurons",
      HD,
    );
    await sql?.unsafe("INSERT INTO t VALUES ($1)", [1]);
    assert.equal(n.sent.length, 1, "must enqueue, not connect");
  });

  test("an UNFLAGGED lane goes direct even with the binding present", async () => {
    const n = namespace();
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: n.ns },
      CTX,
      "chain-detail",
      HD,
    );
    assert.ok(sql, "a direct runner is still a runner");
    assert.deepEqual(n.sent, []);
  });

  test("a flagged lane with NO binding falls through to direct", async () => {
    // A half-applied config. Refusing here would drop capture data over a
    // missing binding, which is the wrong direction to fail.
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER_LANES: "chain-detail" },
      CTX,
      "chain-detail",
      HD,
    );
    assert.ok(sql);
  });

  test("no Hyperdrive and no buffer is no runner at all", async () => {
    assert.equal(neonWriteRunner({}, CTX, "l", undefined), null);
    assert.equal(neonWriteRunner({}, CTX, "l", { connectionString: "" }), null);
  });

  test("a bound Hyperdrive with no ctx is also no runner", async () => {
    // createPgSql needs somewhere to park its teardown.
    assert.equal(neonWriteRunner({}, null, "l", HD), null);
  });
});

describe("every write lane routes through neonWriteRunner", () => {
  test("no src/*-neon-write.ts builds its own connection", async () => {
    // THE OMISSION THIS GUARDS. A lane that keeps calling createPgSql directly
    // still works, still passes its own tests, and silently denies the buffer
    // its saving -- invisible until someone measures the compute again. Six
    // runners had the identical line before #10659; this stops a seventh.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { repoRoot } = await import("../scripts/lib.ts");
    const path = await import("node:path");
    const dir = path.join(repoRoot, "src");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith("-neon-write.ts")) continue;
      const source = readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      if (/\bcreatePgSql\s*\(/.test(source)) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      "these lanes bypass the buffer; use neonWriteRunner",
    );
  });
});

describe("the buffer refuses what it cannot honour", () => {
  function namespace() {
    const sent: unknown[] = [];
    return {
      sent,
      ns: {
        idFromName: (n: string) => n,
        get: () => ({
          async fetch(request: Request) {
            sent.push(await request.json());
            return new Response("{}", { status: 200 });
          },
        }),
      },
    };
  }

  test("a RETURNING statement throws instead of getting an empty result", async () => {
    // The one way buffering could produce a CONFIDENTLY WRONG answer rather
    // than a slow one. `RETURNING id` + `rows.length > 0` is how a caller
    // learns its row was new; `[]` would read as "already present" for a row
    // that has not been written yet. tao_usd_index is exactly this shape.
    const n = namespace();
    const sql = createBufferedPgSql(n.ns, "tao-usd");
    await assert.rejects(
      () =>
        sql.unsafe(
          "INSERT INTO tao_usd_index (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING block_number",
          [1],
        ),
      /cannot defer a statement that RETURNs rows/,
    );
    assert.deepEqual(n.sent, [], "nothing may be enqueued");
  });

  test("case and spacing do not let one slip through", async () => {
    const sql = createBufferedPgSql(namespace().ns, "l");
    await assert.rejects(() =>
      sql.unsafe("INSERT INTO t VALUES (1) returning id"),
    );
  });

  test("the word must stand alone -- a column named returning_at is fine", async () => {
    // A false positive costs a lane the buffer; it must not fire on a column
    // or a string literal that merely contains the word.
    const n = namespace();
    const sql = createBufferedPgSql(n.ns, "l");
    await sql.unsafe("INSERT INTO t (returning_at) VALUES ($1)", [1]);
    assert.equal(n.sent.length, 1);
  });
});

describe("blocks-head can never be buffered", () => {
  test("naming it in the flag is a NO-OP, not an opt-in", async () => {
    // It is the block explorer's live read path, not merely a write:
    // src/blocks-cold-tier.ts routes `block_number > seam` at it, which is the
    // window between a block being seen and being decoded. Deferring that
    // write defers the visible chain tip by the whole flush interval.
    assert.equal(
      neonWriteBufferEnabled(
        { NEON_WRITE_BUFFER_LANES: "blocks-head,neurons" },
        "blocks-head",
      ),
      false,
    );
    // And it does not poison the lanes named beside it.
    assert.equal(
      neonWriteBufferEnabled(
        { NEON_WRITE_BUFFER_LANES: "blocks-head,neurons" },
        "neurons",
      ),
      true,
    );
  });

  test("the runner hands it a DIRECT connection even when flagged", async () => {
    const sent: unknown[] = [];
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        async fetch(request: Request) {
          sent.push(await request.json());
          return new Response("{}", { status: 200 });
        },
      }),
    };
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: ns, NEON_WRITE_BUFFER_LANES: "blocks-head" },
      { waitUntil: () => undefined },
      "blocks-head",
      { connectionString: "postgresql://x" },
    );
    assert.ok(sql, "must still get a runner");
    assert.deepEqual(sent, [], "nothing may be enqueued");
  });

  test("chain-detail is excluded too -- the DETAIL behind each head", () => {
    // Buffering the head and not the detail would be worse than buffering
    // neither: the explorer would list a block it cannot open.
    assert.equal(
      neonWriteBufferEnabled(
        { NEON_WRITE_BUFFER_LANES: "chain-detail" },
        "chain-detail",
      ),
      false,
    );
  });

  test("the never-buffer set names both explorer lanes explicitly", () => {
    assert.deepEqual([...NEVER_BUFFER_LANES].sort(), [
      "blocks-head",
      "chain-detail",
    ]);
  });
});

describe("the enqueue retries a transient stub failure (#10729)", () => {
  function flakyNamespace(failures: number, message: string) {
    let calls = 0;
    const sent: unknown[] = [];
    return {
      get calls() {
        return calls;
      },
      sent,
      ns: {
        idFromName: (n: string) => n,
        get: () => ({
          async fetch(request: Request) {
            calls += 1;
            if (calls <= failures) throw new Error(message);
            sent.push(await request.json());
            return new Response("{}", { status: 200 });
          },
        }),
      },
    };
  }

  test("a Durable Object reset is retried, not lost", async () => {
    // A deploy resets the DO, and an enqueue in flight throws. Without the
    // retry that costs the row AND arms no alarm -- which is what kept the
    // buffer from ever draining on 2026-08-11.
    const n = flakyNamespace(
      1,
      "Durable Object reset because its code was updated",
    );
    const sql = createBufferedPgSql(n.ns, "neurons");
    assert.deepEqual(await sql.unsafe("INSERT INTO t VALUES ($1)", [1]), []);
    assert.equal(n.calls, 2, "it retried once");
    assert.equal(n.sent.length, 1, "and the row landed");
  });

  test("it gives up after the attempt budget and surfaces the error", async () => {
    // NOT unbounded: a genuinely unreachable object must still fail the write
    // so the lane records a stale verdict and the producer retries.
    const n = flakyNamespace(
      99,
      "Durable Object reset because its code was updated",
    );
    await assert.rejects(
      () =>
        createBufferedPgSql(n.ns, "neurons").unsafe("INSERT INTO t VALUES (1)"),
      /Durable Object reset/,
    );
    assert.equal(n.calls, ENQUEUE_ATTEMPTS);
  });

  test("a FULL buffer is not retried -- retrying makes it fuller", async () => {
    // 503 is backpressure, a different thing from a transient. The producer's
    // own cadence is the retry there.
    let calls = 0;
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        async fetch() {
          calls += 1;
          return new Response("{}", { status: 503 });
        },
      }),
    };
    await assert.rejects(
      () =>
        createBufferedPgSql(ns, "neurons").unsafe("INSERT INTO t VALUES (1)"),
      /refused the statement \(503\)/,
    );
    assert.equal(calls, 1, "exactly one attempt");
  });

  test("a non-transient error is not retried either", async () => {
    const n = flakyNamespace(99, "TypeError: something is genuinely broken");
    await assert.rejects(() =>
      createBufferedPgSql(n.ns, "neurons").unsafe("INSERT INTO t VALUES (1)"),
    );
    assert.equal(n.calls, 1);
  });
});

describe("a non-Error throw from the stub", () => {
  test("is still classified, retried, and surfaced as an Error", async () => {
    // Workers RPC can reject with a bare string. Reading `.message` off that
    // yields undefined, so the classifier would see "undefined", treat a
    // genuine transient as fatal, and lose the row -- and the final throw
    // would hand the caller a non-Error nothing up the stack expects.
    let calls = 0;
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        async fetch() {
          calls += 1;
          throw "Durable Object reset because its code was updated";
        },
      }),
    };
    await assert.rejects(
      () =>
        createBufferedPgSql(ns, "neurons").unsafe("INSERT INTO t VALUES (1)"),
      (error: unknown) => {
        assert.ok(error instanceof Error, "must surface as an Error");
        assert.match(String((error as Error).message), /Durable Object reset/);
        return true;
      },
    );
    assert.equal(
      calls,
      ENQUEUE_ATTEMPTS,
      "classified as transient, so retried",
    );
  });
});

describe("oversized statements go direct, not into DO storage (#10744)", () => {
  const HD = { connectionString: "postgresql://x" };
  const CTX = { waitUntil: () => undefined };

  function seam() {
    const enqueued: unknown[] = [];
    const direct: string[] = [];
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        async fetch(request: Request) {
          enqueued.push(await request.json());
          return new Response("{}", { status: 200 });
        },
      }),
    };
    return { enqueued, direct, ns };
  }

  test("a SMALL statement is buffered -- that is the whole point", async () => {
    const s = seam();
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: s.ns, NEON_WRITE_BUFFER_LANES: "neurons" },
      CTX,
      "neurons",
      HD,
    );
    await sql?.unsafe("INSERT INTO neurons VALUES ($1)", [1]);
    assert.equal(s.enqueued.length, 1);
  });

  test("an OVERSIZED statement bypasses the buffer entirely", async () => {
    // DO storage rejected these outright in production -- "Internal error in
    // Durable Object storage caused object to be reset" -- and no retry helps,
    // because the platform is refusing the shape rather than failing
    // transiently. It must never reach storage at all.
    const s = seam();
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: s.ns, NEON_WRITE_BUFFER_LANES: "neurons" },
      CTX,
      "neurons",
      HD,
    );
    const huge = "x".repeat(MAX_BUFFERED_PAYLOAD_BYTES + 1);
    // The direct runner is a real createPgSql against an unusable host, so the
    // proof is that it TRIED to connect rather than enqueueing.
    await assert.rejects(() => sql!.unsafe(`INSERT INTO t VALUES ('${huge}')`));
    assert.deepEqual(s.enqueued, [], "nothing may reach DO storage");
  });

  test("the cap is measured in BYTES, not code units", async () => {
    // A multi-byte payload just under the cap in characters is over it in
    // bytes. Counting characters would let exactly the payloads this exists to
    // stop straight through.
    const twoByte = "τ".repeat(MAX_BUFFERED_PAYLOAD_BYTES - 100);
    assert.ok(payloadBytes(twoByte) > MAX_BUFFERED_PAYLOAD_BYTES);
    assert.ok(twoByte.length < MAX_BUFFERED_PAYLOAD_BYTES);
  });

  test("with NO direct runner an oversized statement still buffers", async () => {
    // Nothing to fall back to. Buffering and failing loudly at the enqueue
    // beats silently dropping a capture row.
    const s = seam();
    const sql = neonWriteRunner(
      { NEON_WRITE_BUFFER: s.ns, NEON_WRITE_BUFFER_LANES: "neurons" },
      null,
      "neurons",
      undefined,
    );
    await sql?.unsafe(
      `INSERT INTO t VALUES ('${"x".repeat(MAX_BUFFERED_PAYLOAD_BYTES + 1)}')`,
    );
    assert.equal(s.enqueued.length, 1);
  });
});
