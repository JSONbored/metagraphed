// The chain-detail sync payload validator (#9208).
//
// The rules that matter are the ones where "reject" and "accept null" are
// DIFFERENT answers for the same-looking absence: an inherent has no signer, an
// uncorrelated extrinsic has no success, a Finalization event has no
// extrinsic_index. Each of those is a real fact the contract carries, and each
// would be destroyed by a validator that either rejected null or accepted it
// everywhere.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_DETAIL_SYNC_MAX_BLOCKS,
  parseChainDetailSync,
} from "../src/chain-detail-sync-payload.ts";

const SYNCED_AT = 1_785_800_000_000;
const HASH = `0x${"ab".repeat(32)}`;
const XT_HASH = `0x${"cd".repeat(32)}`;

function extrinsic(over: Record<string, unknown> = {}) {
  return {
    block_number: 8_762_600,
    extrinsic_index: 0,
    extrinsic_hash: XT_HASH,
    signer: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: true,
    fee_tao: "0.000002131419",
    tip_tao: "0",
    call_args: '[{"name":"netuid","type":"u16","value":1}]',
    observed_at: 1_785_799_000_000,
    ...over,
  };
}

function chainEvent(over: Record<string, unknown> = {}) {
  return {
    block_number: 8_762_600,
    event_index: 0,
    pallet: "Balances",
    method: "Transfer",
    args: '{"amount":30681}',
    phase: "ApplyExtrinsic",
    extrinsic_index: 0,
    observed_at: 1_785_799_000_000,
    ...over,
  };
}

function accountEvent(over: Record<string, unknown> = {}) {
  return {
    block_number: 8_762_600,
    event_index: 0,
    extrinsic_index: 0,
    event_kind: "StakeAdded",
    hotkey: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    coldkey: null,
    netuid: 1,
    uid: 12,
    amount_tao: "1.5",
    alpha_amount: "2.25",
    observed_at: 1_785_799_000_000,
    ...over,
  };
}

function block(over: Record<string, unknown> = {}) {
  return {
    block_number: 8_762_600,
    block_hash: HASH,
    observed_at: 1_785_799_000_000,
    spec_version: 291,
    extrinsics: [extrinsic()],
    chain_events: [chainEvent()],
    account_events: [accountEvent()],
    ...over,
  };
}

function parse(body: unknown) {
  return parseChainDetailSync(body, SYNCED_AT);
}

function rejects(body: unknown, pattern: RegExp, status = 400) {
  const result = parse(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, status);
  assert.match(result.error, pattern);
}

describe("parseChainDetailSync — the happy path", () => {
  test("shapes each family into the writer's exact column set", () => {
    const result = parse({ blocks: [block()] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { blockRows, extrinsicRows, chainEventRows, accountEventRows, head } =
      result.rows;
    assert.equal(head, 8_762_600);
    assert.deepEqual(blockRows, [
      {
        block_number: 8_762_600,
        block_hash: HASH,
        spec_version: 291,
        extrinsic_count: 1,
        chain_event_count: 1,
        account_event_count: 1,
        observed_at: 1_785_799_000_000,
        synced_at: SYNCED_AT,
      },
    ]);
    // success arrives as a JSON boolean and is stored as D1's 0/1 flag.
    assert.equal(extrinsicRows[0].success, 1);
    // The exact decimal string is preserved, never coerced to a number.
    assert.equal(extrinsicRows[0].fee_tao, "0.000002131419");
    assert.equal(typeof extrinsicRows[0].call_args, "string");
    assert.equal(chainEventRows[0].phase, "ApplyExtrinsic");
    assert.equal(accountEventRows[0].amount_tao, "1.5");
  });

  test("head is the MAX across a multi-block batch, not the last entry", () => {
    const result = parse({
      blocks: [
        block({
          block_number: 8_762_601,
          extrinsics: [],
          chain_events: [],
          account_events: [],
        }),
        block({
          block_number: 8_762_600,
          extrinsics: [],
          chain_events: [],
          account_events: [],
        }),
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rows.head, 8_762_601);
  });

  test("the three load-bearing nulls are ACCEPTED, not rejected", () => {
    const result = parse({
      blocks: [
        block({
          // An inherent: no signer, no fee, no correlated success event.
          extrinsics: [
            extrinsic({
              signer: null,
              success: null,
              fee_tao: null,
              tip_tao: null,
              extrinsic_hash: null,
              call_args: null,
            }),
          ],
          // A Finalization event belongs to no extrinsic.
          chain_events: [
            chainEvent({
              phase: "Finalization",
              extrinsic_index: null,
              args: null,
            }),
          ],
          account_events: [
            accountEvent({
              extrinsic_index: null,
              hotkey: null,
              netuid: null,
              uid: null,
              amount_tao: null,
              alpha_amount: null,
            }),
          ],
        }),
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rows.extrinsicRows[0].success, null);
    assert.equal(result.rows.extrinsicRows[0].signer, null);
    assert.equal(result.rows.chainEventRows[0].extrinsic_index, null);
  });

  test("success:false stores 0, not null — a failed extrinsic is not an unknown one", () => {
    const result = parse({
      blocks: [block({ extrinsics: [extrinsic({ success: false })] })],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rows.extrinsicRows[0].success, 0);
  });

  test("a repeated natural key collapses to the LAST copy", () => {
    const result = parse({
      blocks: [
        block({
          extrinsics: [extrinsic(), extrinsic({ call_function: "serve_axon" })],
          chain_events: [chainEvent(), chainEvent({ method: "Withdraw" })],
          account_events: [accountEvent(), accountEvent({ netuid: 7 })],
        }),
        block(),
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rows.blockRows.length, 1);
    assert.equal(result.rows.extrinsicRows.length, 1);
    assert.equal(result.rows.chainEventRows.length, 1);
    assert.equal(result.rows.accountEventRows.length, 1);
    // The block re-sent LAST wins, which is what a re-POST means.
    assert.equal(result.rows.extrinsicRows[0].call_function, "set_weights");
  });
});

describe("parseChainDetailSync — what it refuses", () => {
  test("a body that is not {blocks:[...]}, or an empty batch", () => {
    rejects(null, /must be \{blocks/);
    rejects({}, /must be \{blocks/);
    rejects({ blocks: {} }, /must be \{blocks/);
    rejects({ blocks: [] }, /must be \{blocks/);
    rejects({ blocks: ["nope"] }, /entries must be objects/);
  });

  test("too many blocks is a 413, not a 400", () => {
    rejects(
      {
        blocks: Array.from(
          { length: CHAIN_DETAIL_SYNC_MAX_BLOCKS + 1 },
          (_, i) => block({ block_number: 8_000_000 + i }),
        ),
      },
      /at most 16 blocks/,
      413,
    );
  });

  test("too many detail rows is a 413", () => {
    // 16 blocks x 5,001 events clears the 80,000-row ceiling.
    rejects(
      {
        blocks: Array.from({ length: CHAIN_DETAIL_SYNC_MAX_BLOCKS }, (_, b) =>
          block({
            block_number: 8_000_000 + b,
            extrinsics: [],
            account_events: [],
            chain_events: Array.from({ length: 5_001 }, (_, i) =>
              chainEvent({ block_number: 8_000_000 + b, event_index: i }),
            ),
          }),
        ),
      },
      /at most 80000 detail rows/,
      413,
    );
  });

  test("block-envelope fields", () => {
    rejects(
      { blocks: [block({ block_number: -1 })] },
      /block_number must be an index/,
    );
    rejects(
      { blocks: [block({ block_number: 1.5 })] },
      /block_number must be an index/,
    );
    rejects(
      { blocks: [block({ block_hash: "0xdeadbeef" })] },
      /block_hash must be/,
    );
    rejects(
      { blocks: [block({ observed_at: 0 })] },
      /observed_at must be epoch ms/,
    );
    rejects(
      { blocks: [block({ spec_version: null })] },
      /spec_version must be/,
    );
    rejects({ blocks: [block({ extrinsics: null })] }, /each block needs/);
    rejects({ blocks: [block({ chain_events: null })] }, /each block needs/);
    rejects({ blocks: [block({ account_events: null })] }, /each block needs/);
  });

  test("a row whose block_number disagrees with its block's", () => {
    rejects(
      { blocks: [block({ extrinsics: [extrinsic({ block_number: 1 })] })] },
      /an extrinsic's block_number must equal/,
    );
    rejects(
      { blocks: [block({ chain_events: [chainEvent({ block_number: 1 })] })] },
      /a chain event's block_number must equal/,
    );
    rejects(
      {
        blocks: [
          block({ account_events: [accountEvent({ block_number: 1 })] }),
        ],
      },
      /an account event's block_number must equal/,
    );
  });

  test("extrinsic fields", () => {
    const bad = (over: Record<string, unknown>, pattern: RegExp) =>
      rejects({ blocks: [block({ extrinsics: [extrinsic(over)] })] }, pattern);
    rejects(
      { blocks: [block({ extrinsics: ["x"] })] },
      /entries must be objects/,
    );
    bad({ extrinsic_index: -1 }, /extrinsic_index must be an index/);
    bad({ extrinsic_hash: "0xshort" }, /extrinsic_hash must be/);
    bad({ signer: 42 }, /signer must be a string or null/);
    bad({ signer: "x".repeat(513) }, /signer must be a string or null/);
    bad({ call_module: 7 }, /call_module\/call_function/);
    bad({ call_function: 7 }, /call_module\/call_function/);
    bad({ success: "true" }, /success must be a boolean or null/);
    bad({ fee_tao: 0.1 }, /exact decimal strings/);
    bad({ fee_tao: "1e21" }, /exact decimal strings/);
    bad({ tip_tao: "abc" }, /exact decimal strings/);
    bad(
      { call_args: { netuid: 1 } },
      /call_args must be a JSON-encoded string/,
    );
    bad({ observed_at: "now" }, /an extrinsic's observed_at/);
  });

  test("chain-event fields, including the closed phase set", () => {
    const bad = (over: Record<string, unknown>, pattern: RegExp) =>
      rejects(
        { blocks: [block({ chain_events: [chainEvent(over)] })] },
        pattern,
      );
    rejects(
      { blocks: [block({ chain_events: [1] })] },
      /entries must be objects/,
    );
    bad({ event_index: "0" }, /event_index must be an index/);
    bad({ pallet: "" }, /pallet must be an identifier/);
    bad({ pallet: "Bad.Pallet" }, /pallet must be an identifier/);
    bad({ method: 5 }, /method must be an identifier/);
    bad({ args: [1, 2] }, /args must be a JSON-encoded string/);
    // A phase the Worker does not understand would be stored as an unqueryable
    // string, so it is rejected rather than kept.
    bad({ phase: "OnIdle" }, /phase must be one of/);
    bad({ extrinsic_index: -3 }, /a chain event's extrinsic_index/);
    bad({ observed_at: -1 }, /a chain event's observed_at/);
  });

  test("account-event fields, including the pallet-qualified event_kind trap", () => {
    const bad = (over: Record<string, unknown>, pattern: RegExp) =>
      rejects(
        { blocks: [block({ account_events: [accountEvent(over)] })] },
        pattern,
      );
    rejects(
      { blocks: [block({ account_events: [null] })] },
      /entries must be objects/,
    );
    bad({ event_index: null }, /event_index must be an index/);
    bad({ extrinsic_index: "0" }, /an account event's extrinsic_index/);
    // The lakehouse column holds the bare variant; a qualified value here would
    // make ?kind= match on one tier and miss on the other.
    bad({ event_kind: "SubtensorModule.StakeAdded" }, /bare variant name/);
    bad({ event_kind: "" }, /bare variant name/);
    bad({ hotkey: 1 }, /hotkey\/coldkey/);
    bad({ coldkey: {} }, /hotkey\/coldkey/);
    bad({ netuid: -1 }, /netuid\/uid must be indexes/);
    bad({ uid: 1.5 }, /netuid\/uid must be indexes/);
    bad({ amount_tao: 1 }, /exact decimal strings/);
    bad({ alpha_amount: "1.2.3" }, /exact decimal strings/);
    bad({ observed_at: null }, /an account event's observed_at/);
  });
});
