import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  V2BlockListSchema,
  V2BlockSchema,
  V2AccountEventsSchema,
  V2AccountStakeSchema,
} from "../schemas-src/v2/contracts.ts";
import { createModernApplication } from "../src/modern-application.ts";
import { createV2ReadClient } from "../src/v2/client.ts";
import {
  MODERN_FIXTURE,
  modernVerificationFixture,
} from "../scripts/lib/modern-verification-fixture.ts";

const applications: ReturnType<typeof createModernApplication>[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
});
const snapshot =
  "block_number block_hash parent_hash metadata_digest spec_version transaction_version producer_revision publication_id observed_at published_at";
const envelope = `api_version network { id genesis_hash } snapshot { ${snapshot} } freshness { status age_seconds finalized_lag_blocks target_seconds target_blocks }`;
const blockSelection = `${envelope} source_capture_digest event_count extrinsic_count next_event_index next_extrinsic_index events { event_index pallet variant fields phase extrinsic_index topics participants { participant_index account_id role } } extrinsics { extrinsic_index extrinsic_hash pallet call fields is_signed signer }`;
const listSelection = `${envelope} coverage { from_block through_block contiguous } next_before blocks { snapshot { ${snapshot} } source_capture_digest event_count extrinsic_count }`;
const post = (path: string, body: unknown) =>
  new Request(`${MODERN_FIXTURE.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

function fixture(change?: (row: Record<string, unknown>) => void) {
  const data = modernVerificationFixture();
  const executor = {
    async query(sql: string, values: unknown[]) {
      const result = await data.executor.query(sql, values);
      if (change && sql.startsWith("WITH selected AS MATERIALIZED")) {
        result.rows = result.rows.map((value) => {
          const row = z.record(z.string(), z.unknown()).parse(value);
          change(row);
          return row;
        });
      }
      return result;
    },
  };
  const app = createModernApplication(executor, {
    origin: MODERN_FIXTURE.origin,
    now: () => new Date(MODERN_FIXTURE.now),
  });
  applications.push(app);
  const reader = createV2ReadClient({
    origin: MODERN_FIXTURE.origin,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  return { ...data, app, reader };
}
async function rpcValue(
  response: Response,
  expectedId: number,
): Promise<{ result: { structuredContent?: unknown; isError?: boolean } }> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const text = await response.text();
  const messages = text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [JSON.parse(data) as unknown] : [];
  });
  expect(messages).toHaveLength(1);
  const message = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.number(),
      result: z
        .object({
          structuredContent: z.unknown().optional(),
          isError: z.boolean().optional(),
        })
        .passthrough(),
    })
    .parse(messages[0]);
  expect(message.id).toBe(expectedId);
  return message;
}
async function mcp(app: ReturnType<typeof createModernApplication>) {
  const init = await app.fetch(
    post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "explorer-fixture", version: "1" },
      },
    }),
  );
  expect((await rpcValue(init, 1)).result).toMatchObject({
    protocolVersion: "2025-11-25",
  });
  const session = init.headers.get("mcp-session-id")!;
  expect(session).toBeTruthy();
  const send = (body: unknown) => {
    const request = post("/mcp", body);
    request.headers.set("mcp-session-id", session);
    request.headers.set("mcp-protocol-version", "2025-11-25");
    return app.fetch(request);
  };
  expect(
    (await send({ jsonrpc: "2.0", method: "notifications/initialized" }))
      .status,
  ).toBe(202);
  let id = 1;
  return async (name: string, args: unknown) => {
    const requestId = ++id;
    return rpcValue(
      await send({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      requestId,
    );
  };
}

describe("one published explorer operation across public transports", () => {
  test("returns identical stake and claim-only evidence through REST GraphQL MCP and canonical client", async () => {
    const f = fixture();
    const account = `0x${"b".repeat(64)}`;
    const input = {
      network: "finney",
      account_id: account,
      publication_id: "e".repeat(64),
      limit: 10,
    };
    const response = await f.app.fetch(
      new Request(
        `${MODERN_FIXTURE.origin}/api/v2/networks/finney/accounts/${account}/stake?limit=10&publication_id=${input.publication_id}`,
      ),
    );
    expect(response.status).toBe(200);
    const rest = V2AccountStakeSchema.parse(await response.json());
    expect(rest.entries).toHaveLength(1);
    expect(rest.entries[0].kind).toBe("root_entitlement");
    expect(rest.snapshot.spec_version).toBe(486);
    expect(rest.stake.state.spec_version).toBe(488);
    const call = await mcp(f.app);
    expect(
      (await call("list_account_stake", input)).result.structuredContent,
    ).toEqual(rest);
    expect(await f.reader.read("list_account_stake", input)).toEqual(rest);
    const graphql = await f.app.fetch(
      post("/graphql", {
        query: `{ list_account_stake(input:{network:"finney",account_id:"${account}",limit:10,publication_id:"${input.publication_id}"}) {
      ${envelope} account_id entries next_cursor stake { publication_id source_id account_scope census_complete state { snapshot_id metadata_digest spec_version } }
    } }`,
      }),
    );
    expect(await graphql.json()).toEqual({
      data: {
        list_account_stake: {
          api_version: rest.api_version,
          network: rest.network,
          snapshot: rest.snapshot,
          freshness: rest.freshness,
          account_id: account,
          entries: rest.entries,
          next_cursor: null,
          stake: {
            publication_id: rest.stake.publication_id,
            source_id: rest.stake.source_id,
            account_scope: "coldkey",
            census_complete: true,
            state: {
              snapshot_id: rest.stake.state.snapshot_id,
              metadata_digest: rest.stake.state.metadata_digest,
              spec_version: 488,
            },
          },
        },
      },
    });
  });
  test("returns the same account event evidence through all public read transports", async () => {
    const f = fixture();
    const account = `0x${"a".repeat(64)}`;
    const input = { network: "finney", account_id: account, limit: 2 };
    const response = await f.app.fetch(
      new Request(
        `${MODERN_FIXTURE.origin}/api/v2/networks/finney/accounts/${account}/events?limit=2`,
      ),
    );
    expect(response.status).toBe(200);
    const rest = V2AccountEventsSchema.parse(await response.json());
    expect(rest.events).toHaveLength(1);
    expect(rest.events[0].matching_participants[0].account_id).toBe(account);
    const call = await mcp(f.app);
    expect(
      (await call("list_account_events", input)).result.structuredContent,
    ).toEqual(rest);
    expect(await f.reader.read("list_account_events", input)).toEqual(rest);
    const graphql = await f.app.fetch(
      post("/graphql", {
        query: `{ list_account_events(input:{network:"finney",account_id:"${account}",limit:2}) { account_id events { event { event_index } matching_participants { participant_index } } } }`,
      }),
    );
    expect(await graphql.json()).toEqual({
      data: {
        list_account_events: {
          account_id: account,
          events: [
            {
              event: { event_index: 0 },
              matching_participants: [{ participant_index: 0 }],
            },
          ],
        },
      },
    });
  });
  test("lists each block's own publication identically through REST, GraphQL, MCP and canonical client", async () => {
    const f = fixture();
    const path = "/api/v2/networks/finney/blocks?limit=2";
    const response = await f.app.fetch(
      new Request(MODERN_FIXTURE.origin + path),
    );
    expect(response.status).toBe(200);
    const rest = V2BlockListSchema.parse(await response.json());
    expect(rest.blocks.map((row) => row.snapshot.block_number)).toEqual([
      "123",
      "122",
    ]);
    expect(rest.blocks[1].snapshot.publication_id).not.toBe(
      rest.snapshot.publication_id,
    );
    const graphql = await f.app.fetch(
      post("/graphql", {
        query: `{ list_blocks(input: { network: "finney", limit: 2 }) { ${listSelection} } }`,
      }),
    );
    expect(await graphql.json()).toEqual({ data: { list_blocks: rest } });
    const call = await mcp(f.app);
    const tool = await call("list_blocks", { network: "finney", limit: 2 });
    expect(tool.result.structuredContent).toEqual(rest);
    expect(
      await f.reader.read("list_blocks", { network: "finney", limit: 2 }),
    ).toEqual(rest);
    const next = await f.reader.read("list_blocks", {
      network: "finney",
      limit: 2,
      anchor_height: rest.snapshot.block_number,
      anchor_hash: rest.snapshot.block_hash,
      anchor_publication_id: rest.snapshot.publication_id,
      from_block: rest.coverage.from_block,
      before: rest.next_before!,
    });
    expect(next.blocks.map((row) => row.snapshot.block_number)).toEqual([
      "121",
      "120",
    ]);
    expect(next.next_before).toBeNull();
    expect(f.errors).toEqual([]);
  });
  test("shares decoded event phase, origin, topics, participants and independent continuation pins", async () => {
    const f = fixture();
    const pins = {
      block_hash: MODERN_FIXTURE.blockHash,
      publication_id: MODERN_FIXTURE.publication,
    };
    const input = {
      network: "finney",
      height: "123",
      ...pins,
      limit: 1,
      extrinsic_limit: 1,
    };
    const rest = await f.reader.read("get_block", input);
    expect(rest.next_event_index).toBe(0);
    expect(rest.next_extrinsic_index).toBeNull();
    expect(rest.events[0]).toMatchObject({
      phase: "ApplyExtrinsic",
      extrinsic_index: 0,
      fields: { amount_rao: "9007199254740993" },
      participants: [{ role: "sender" }],
    });
    const inline = await f.app.fetch(
      post("/graphql", {
        query: `{ get_block(input: { network: "finney", height: "123", block_hash: "${pins.block_hash}", publication_id: "${pins.publication_id}", limit: 1, extrinsic_limit: 1 }) { ${blockSelection} } }`,
      }),
    );
    expect(await inline.json()).toEqual({ data: { get_block: rest } });
    const call = await mcp(f.app);
    expect((await call("get_block", input)).result.structuredContent).toEqual(
      rest,
    );
    const next = V2BlockSchema.parse(
      await f.reader.read("get_block", { ...input, after_event_index: 0 }),
    );
    expect(next.events.map((event) => event.event_index)).toEqual([1]);
    expect(next.extrinsics).toEqual(rest.extrinsics);
    expect(next.next_event_index).toBeNull();
    expect(f.errors).toEqual([]);
  });
  test("refuses bad pins before reads and differentiates missing blocks from unavailable provenance", async () => {
    const f = fixture();
    const initial = f.calls.length;
    for (const query of [
      "before=122",
      "anchor_height=123",
      "after_event_index=0",
      `block_hash=${MODERN_FIXTURE.blockHash}`,
    ]) {
      const suffix =
        query.startsWith("before") || query.startsWith("anchor")
          ? "blocks"
          : "blocks/123";
      expect(
        (
          await f.app.fetch(
            new Request(
              `${MODERN_FIXTURE.origin}/api/v2/networks/finney/${suffix}?${query}`,
            ),
          )
        ).status,
      ).toBe(400);
    }
    expect(f.calls).toHaveLength(initial);
    const unavailable = await f.app.fetch(
      new Request(
        `${MODERN_FIXTURE.origin}/api/v2/networks/finney/blocks/123?block_hash=${MODERN_FIXTURE.blockHash}&publication_id=${"f".repeat(64)}`,
      ),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "data_unavailable" },
    });
    const absent = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin: MODERN_FIXTURE.origin },
    );
    applications.push(absent);
    const missing = await absent.fetch(
      new Request(`${MODERN_FIXTURE.origin}/api/v2/networks/finney/blocks/999`),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "not_found" },
    });
    expect(f.errors).toEqual([]);
  });
  test("returns unavailable evidence for withdrawn custody and corrupt body indexes", async () => {
    for (const change of [
      (row: Record<string, unknown>) => {
        row.integrity_verified = null;
      },
      (row: Record<string, unknown>) => {
        row.actual_event_count = 0;
      },
      (row: Record<string, unknown>) => {
        const events = z
          .array(z.record(z.string(), z.unknown()))
          .parse(row.events);
        events[0].participants = [
          {
            participant_index: 2,
            account_id: `0x${"a".repeat(64)}`,
            role: "sender",
          },
        ];
        row.events = events;
      },
    ]) {
      const f = fixture(change);
      const response = await f.app.fetch(
        new Request(
          `${MODERN_FIXTURE.origin}/api/v2/networks/finney/blocks/123`,
        ),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "data_unavailable" },
      });
      const call = await mcp(f.app);
      const result = await call("get_block", {
        network: "finney",
        height: "123",
      });
      expect(result.result).toMatchObject({ isError: true });
      expect(result.result).not.toHaveProperty("structuredContent");
      expect(f.errors).toEqual([]);
    }
  });
});
