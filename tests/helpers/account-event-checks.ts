import assert from "node:assert/strict";
import { V2AccountEventCursorSchema } from "../../schemas-src/v2/contracts.ts";
import {
  decodeAccountEventCursor,
  encodeAccountEventCursor,
} from "../../src/v2/account-event-cursor.ts";
import { createV2Operations } from "../../src/v2/operations.ts";
import { createV2Handler } from "../../src/v2/api.ts";
import { createV2ReadClient } from "../../src/v2/client.ts";
import { createModernApplication } from "../../src/modern-application.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const account = hash("a");
const now = "2026-11-05T14:00:00.000Z";
const source = {
  network_id: "finney",
  genesis_hash: hash("0"),
  block_number: "123",
  block_hash: hash("1"),
  parent_hash: hash("2"),
  metadata_digest: "3".repeat(64),
  producer_revision: "4".repeat(40),
  publication_id: "5".repeat(64),
  spec_version: 488,
  transaction_version: 1,
  observed_at: now,
  published_at: now,
  finalized_observed_height: "123",
  finalized_observed_hash: hash("1"),
  finalized_observed_at: now,
  integrity_verified: true,
  stage: "published",
  raw_digest: "6".repeat(64),
  event_count: 3,
  extrinsic_count: 0,
};
const participant = (index: number, account_id = account) => ({
  participant_index: index,
  account_id,
  role: `field_${index}`,
});
const event = (index: number) => ({
  event_index: index,
  pallet: "Controlled",
  variant: "Observed",
  fields: { amount: "18446744073709551615" },
  phase: "Finalization",
  extrinsic_index: null,
  topics: [],
  participants: [participant(0), participant(1, hash("b")), participant(2)],
});
const row = () => ({
  head: {
    ...source,
    complete_from: "120",
    complete_through: "123",
    checkpoint_hash: source.block_hash,
    checkpoint_publication_id: source.publication_id,
    has_gap: false,
  },
  anchor: { ...source },
  coverage: {
    block_count: "4",
    first_block: "120",
    last_block: "123",
    valid: true,
  },
  revision: { generation: "2", publication_id: source.publication_id },
  within_budget: true,
  has_more: false,
  events: [2, 1].map((index) => ({
    source: { ...source },
    event: event(index),
    matching_participants: [participant(0), participant(2)],
  })),
});
const cursor = {
  version: 1 as const,
  network: "finney",
  genesis_hash: source.genesis_hash,
  account_id: account,
  from_block: "120",
  anchor_height: "123",
  anchor_hash: source.block_hash,
  anchor_publication_id: source.publication_id,
  revision_generation: "2",
  revision_publication_id: source.publication_id,
  before_block: "123",
  before_event_index: 2,
};
function fixture(change?: (value: ReturnType<typeof row>) => void) {
  const calls: unknown[][] = [];
  const executor = {
    async query(_sql: string, values: unknown[]) {
      calls.push(values);
      const value = row();
      change?.(value);
      return { rows: [value] };
    },
  };
  const operations = createV2Operations(executor, { now: () => new Date(now) });
  return { calls, executor, operations, handler: createV2Handler(operations) };
}
const input = { network: "finney", account_id: account, limit: 2 };
const rejected = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;

export function registerAccountEventChecks(
  test: (name: string, check: () => void | Promise<void>) => void,
) {
  test("account cursor canonical roundtrip and malformed encodings", () => {
    const encoded = encodeAccountEventCursor(cursor);
    assert.deepEqual(decodeAccountEventCursor(encoded), cursor);
    const raw = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const value of [
      "",
      "x".repeat(2049),
      encoded + "=",
      "_w",
      raw({ ...cursor, extra: true }),
      raw({ ...cursor, version: 2 }),
      raw({ ...cursor, from_block: "0120" }),
      raw({ ...cursor, from_block: "124" }),
      raw({ ...cursor, before_block: "119" }),
      raw({ ...cursor, revision_generation: "0" }),
      Buffer.from(" " + JSON.stringify(cursor)).toString("base64url"),
      raw(Object.fromEntries(Object.entries(cursor).reverse())),
    ])
      assert.throws(
        () => decodeAccountEventCursor(value),
        /^Error: Invalid account event cursor$/,
      );
    assert.equal(
      V2AccountEventCursorSchema.safeParse({ ...cursor, from_block: "invalid" })
        .success,
      false,
    );
  });

  test("account events return one event with every original matching position in one query", async () => {
    const f = fixture();
    const result = await f.operations.list_account_events(input);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], [
      "finney",
      account,
      null,
      null,
      null,
      null,
      2,
    ]);
    assert.equal(result.events.length, 2);
    assert.deepEqual(
      result.events[0].matching_participants.map((p) => p.participant_index),
      [0, 2],
    );
    assert.deepEqual(result.events[0].event.fields, {
      amount: "18446744073709551615",
    });
    assert.equal(result.next_cursor, null);
  });

  test("account events cursor binds account and network before querying", async () => {
    for (const extra of [
      { cursor: "invalid" },
      {
        cursor: encodeAccountEventCursor({ ...cursor, account_id: hash("b") }),
      },
      { cursor: encodeAccountEventCursor({ ...cursor, network: "testnet" }) },
      { cursor: encodeAccountEventCursor(cursor), from_block: "120" },
    ]) {
      const f = fixture();
      await assert.rejects(
        f.operations.list_account_events({ ...input, ...extra }),
        rejected("invalid_input"),
      );
      assert.equal(f.calls.length, 0);
    }
  });

  test("account events continuation pins exact interval and last event", async () => {
    const f = fixture((value) => {
      value.has_more = true;
    });
    const first = await f.operations.list_account_events(input);
    assert.ok(first.next_cursor);
    const decoded = decodeAccountEventCursor(first.next_cursor);
    assert.deepEqual(decoded, { ...cursor, before_event_index: 1 });
    const next = fixture((value) => {
      value.events = [];
    });
    const page = await next.operations.list_account_events({
      ...input,
      cursor: first.next_cursor,
    });
    assert.deepEqual(next.calls[0], [
      "finney",
      account,
      "120",
      "123",
      "123",
      1,
      2,
    ]);
    assert.deepEqual(page.events, []);
  });

  test("account events reject changed interval receipts and malformed payloads", async () => {
    let nested: unknown = null;
    for (let index = 0; index < 34; index++) nested = { child: nested };
    const changes: ((value: ReturnType<typeof row>) => void)[] = [
      (v) => {
        v.coverage.block_count = "3";
      },
      (v) => {
        v.coverage.first_block = "119";
      },
      (v) => {
        v.coverage.valid = false;
      },
      (v) => {
        v.head.has_gap = true;
      },
      (v) => {
        v.within_budget = false;
      },
      (v) => {
        v.anchor.genesis_hash = hash("c");
      },
      (v) => {
        v.head.checkpoint_hash = hash("c");
      },
      (v) => {
        v.events.reverse();
      },
      (v) => {
        v.events[1] = v.events[0];
      },
      (v) => {
        v.events[0].event.event_index = 3;
      },
      (v) => {
        v.events[0].matching_participants.pop();
      },
      (v) => {
        v.events[0].matching_participants = Array.from({ length: 257 }, () =>
          participant(0),
        );
      },
      (v) => {
        v.events[0].event.participants = Array.from({ length: 257 }, () =>
          participant(0),
        );
      },
      (v) => {
        Object.assign(v.events[0].event, {
          topics: Array.from({ length: 257 }, () => hash("1")),
        });
      },
      (v) => {
        v.events[0].event.participants[1].participant_index = 3;
      },
      (v) => {
        v.events[0].source.publication_id = "7".repeat(64);
      },
      (v) => {
        v.events[0].source.metadata_digest = "7".repeat(64);
      },
      (v) => {
        v.events[0].source.block_number = "119";
      },
      (v) => {
        v.events[0].event.fields = { amount: "x".repeat(262145) };
      },
      (v) => {
        Object.assign(v.events[0].event, { fields: { amount: 1.1 } });
      },
      (v) => {
        Object.assign(v.events[0].event, { fields: nested });
      },
      (v) => {
        Object.assign(v.events[0].event, {
          phase: "ApplyExtrinsic",
          extrinsic_index: 0,
        });
      },
    ];
    for (const change of changes)
      await assert.rejects(
        fixture(change).operations.list_account_events(input),
        rejected("data_unavailable"),
      );
    await assert.rejects(
      fixture((value) => {
        for (const row of value.events) row.source.block_number = "122";
        value.events[1].source.metadata_digest = "7".repeat(64);
      }).operations.list_account_events(input),
      rejected("data_unavailable"),
    );
    for (const change of [
      (v: ReturnType<typeof row>) => {
        v.revision.generation = "3";
      },
      (v: ReturnType<typeof row>) => {
        v.revision.publication_id = "8".repeat(64);
      },
      (v: ReturnType<typeof row>) => {
        v.anchor.block_hash = hash("c");
      },
    ])
      await assert.rejects(
        fixture(change).operations.list_account_events({
          ...input,
          cursor: encodeAccountEventCursor(cursor),
        }),
        rejected("data_unavailable"),
      );
  });

  test("account REST owns only strict account paths and selectors", async () => {
    const f = fixture();
    const path = `https://example.test/api/v2/networks/finney/accounts/${account}/events`;
    assert.equal((await f.handler(new Request(path))).status, 200);
    for (const query of [
      "?limit=2&limit=2",
      "?account_id=x",
      "?cursor=x",
      "?limit=02",
    ])
      assert.equal((await f.handler(new Request(path + query))).status, 400);
    assert.equal(
      (await f.handler(new Request(path, { method: "POST" }))).status,
      405,
    );
    assert.equal((await f.handler(new Request(path + "/other"))).status, 404);
  });

  test("account client validates request bindings before fetching", async () => {
    let calls = 0;
    const client = createV2ReadClient({
      origin: "https://example.test",
      fetch: async () => {
        calls++;
        throw new Error("must not fetch");
      },
    });
    for (const value of [
      "invalid",
      encodeAccountEventCursor({ ...cursor, account_id: hash("b") }),
      encodeAccountEventCursor({ ...cursor, network: "testnet" }),
    ])
      await assert.rejects(
        client.read("list_account_events", { ...input, cursor: value }),
        rejected("invalid_input"),
      );
    await assert.rejects(
      client.read(
        "list_account_events",
        { ...input, cursor: encodeAccountEventCursor(cursor) },
        { expectedGenesisHash: hash("f") },
      ),
      rejected("invalid_input"),
    );
    assert.equal(calls, 0);
  });

  test("account client rejects wrong response identity order matches and next cursor", async () => {
    const valid = await fixture((value) => {
      value.has_more = true;
    }).operations.list_account_events(input);
    const changes: ((v: typeof valid) => void)[] = [
      (v) => {
        v.account_id = hash("b");
      },
      (v) => {
        v.events.reverse();
      },
      (v) => {
        v.events[0].matching_participants.pop();
      },
      (v) => {
        v.next_cursor = encodeAccountEventCursor({
          ...cursor,
          before_event_index: 0,
        });
      },
      (v) => {
        v.coverage.through_block = "124";
      },
      (v) => {
        v.events[0].snapshot.publication_id = "7".repeat(64);
      },
      (v) => {
        v.events[0].event.fields = { amount: 1.1 };
      },
      (v) => {
        v.events[0].matching_participants = Array.from({ length: 257 }, () =>
          participant(0),
        );
      },
      (v) => {
        v.events[0].event.participants = Array.from({ length: 257 }, () =>
          participant(0),
        );
      },
      (v) => {
        v.events[0].event.topics = Array.from({ length: 257 }, () => hash("1"));
      },
    ];
    for (const change of changes) {
      const value = structuredClone(valid);
      change(value);
      const client = createV2ReadClient({
        origin: "https://example.test",
        fetch: async () => Response.json(value),
      });
      await assert.rejects(
        client.read("list_account_events", input),
        (e: unknown) =>
          e instanceof Error &&
          "code" in e &&
          ["pagination_mismatch", "response_rejected"].includes(String(e.code)),
      );
    }
    const continuation = await fixture((value) => {
      value.events = value.events.slice(0, 1);
      value.events[0].event.event_index = 0;
    }).operations.list_account_events({ ...input, cursor: valid.next_cursor! });
    for (const change of [
      (v: typeof continuation) => {
        v.network.genesis_hash = hash("e");
      },
      (v: typeof continuation) => {
        v.snapshot.block_hash = hash("e");
      },
      (v: typeof continuation) => {
        v.snapshot.publication_id = "8".repeat(64);
      },
      (v: typeof continuation) => {
        v.revision.generation = "3";
      },
      (v: typeof continuation) => {
        v.revision.publication_id = "8".repeat(64);
      },
      (v: typeof continuation) => {
        v.coverage.from_block = "119";
      },
      (v: typeof continuation) => {
        let nested: unknown = null;
        for (let index = 0; index < 34; index++) nested = { child: nested };
        Object.assign(v.events[0].event, { fields: nested });
      },
    ]) {
      const value = structuredClone(continuation);
      change(value);
      const client = createV2ReadClient({
        origin: "https://example.test",
        fetch: async () => Response.json(value),
      });
      await assert.rejects(
        client.read("list_account_events", {
          ...input,
          cursor: valid.next_cursor!,
        }),
      );
    }
  });

  test("account activity is shared by REST GraphQL MCP and canonical client", async () => {
    const f = fixture();
    const app = createModernApplication(f.executor, {
      origin: "https://example.test",
      now: () => new Date(now),
    });
    const post = (path: string, body: unknown) =>
      new Request("https://example.test" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    try {
      const client = createV2ReadClient({
        origin: "https://example.test",
        fetch: (url, init) => app.fetch(new Request(url, init)),
      });
      const result = await client.read("list_account_events", input);
      const response = await app.fetch(
        post("/graphql", {
          query: `{ list_account_events(input:{network:"finney",account_id:"${account}",limit:2}) { account_id events { event { event_index } matching_participants { participant_index } } } }`,
        }),
      );
      assert.deepEqual(await response.json(), {
        data: {
          list_account_events: {
            account_id: account,
            events: result.events.map((row) => ({
              event: { event_index: row.event.event_index },
              matching_participants: row.matching_participants.map((p) => ({
                participant_index: p.participant_index,
              })),
            })),
          },
        },
      });
      const init = await app.fetch(
        post("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "account-fixture", version: "1" },
          },
        }),
      );
      await init.text();
      const session = init.headers.get("mcp-session-id");
      assert.ok(session);
      const send = (body: unknown) => {
        const request = post("/mcp", body);
        request.headers.set("mcp-session-id", session);
        request.headers.set("mcp-protocol-version", "2025-11-25");
        return app.fetch(request);
      };
      assert.equal(
        (await send({ jsonrpc: "2.0", method: "notifications/initialized" }))
          .status,
        202,
      );
      const reply = await send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_account_events", arguments: input },
      });
      assert.equal(reply.status, 200);
      const frames = (await reply.text())
        .split(/\r?\n\r?\n/)
        .flatMap((frame) => {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          return data ? [JSON.parse(data) as unknown] : [];
        });
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0], {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } finally {
      await app.close();
    }
  });
}
