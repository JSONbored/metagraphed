// Per-UID eviction events (#9873).
//
// The derivation has always produced these -- deregistrationsByNetuid throws
// them away to make counts -- so this is a publishing change, not a new data
// path. These tests pin the two things that make it honest: the events say who
// LOST the slot (not who took it), and the lower-bound caveat that governs the
// counts governs the events too.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  deregistrationsByNetuidUid,
  deriveDeregistrations,
} from "../src/deregistration-derivation.ts";
import type { Row } from "./row-type.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 7);

/** Three registrations on one slot: A -> B -> C, plus an untouched slot. */
function registrations(): Row[] {
  return [
    {
      netuid: 53,
      uid: 7,
      hotkey: "hk-A",
      block_number: 100,
      event_index: 1,
      observed_at: now - 20 * DAY,
    },
    {
      netuid: 53,
      uid: 7,
      hotkey: "hk-B",
      block_number: 200,
      event_index: 1,
      observed_at: now - 10 * DAY,
    },
    {
      netuid: 53,
      uid: 7,
      hotkey: "hk-C",
      block_number: 350,
      event_index: 1,
      observed_at: now - 2 * DAY,
    },
    {
      netuid: 53,
      uid: 9,
      hotkey: "hk-D",
      block_number: 120,
      event_index: 1,
      observed_at: now - 18 * DAY,
    },
    {
      netuid: 64,
      uid: 1,
      hotkey: "hk-E",
      block_number: 130,
      event_index: 1,
      observed_at: now - 15 * DAY,
    },
    {
      netuid: 64,
      uid: 1,
      hotkey: "hk-F",
      block_number: 260,
      event_index: 1,
      observed_at: now - 5 * DAY,
    },
  ];
}

describe("deregistrationsByNetuidUid (#9873)", () => {
  const derived = deriveDeregistrations(registrations(), {
    since: now - 30 * DAY,
  });
  const index = deregistrationsByNetuidUid(derived.events);

  test("names the DISPLACED holder, not the arrival", () => {
    // The whole point: this event is a deregistration OF hk-A, caused BY hk-B.
    // Getting these the wrong way round would name the wrong operator as
    // evicted, and nothing downstream could tell.
    const rows = index["53"];
    const first = rows.find((r) => r[3] === 200)!;
    assert.equal(first[0], 7, "uid");
    assert.equal(first[1], "hk-A", "displaced");
    assert.equal(first[2], "hk-B", "successor");
  });

  test("keys by netuid and orders newest-first", () => {
    assert.deepEqual(Object.keys(index).sort(), ["53", "64"]);
    // A caller taking the first N wants the most recent N -- the question is
    // about recent churn.
    const observed = index["53"].map((r) => r[4]);
    assert.deepEqual(
      observed,
      [...observed].sort((a, b) => b - a),
    );
  });

  test("carries tenure, so a caller can see the pruning ORDER", () => {
    // hk-A held blocks 100..200, hk-B held 200..350. Without this a caller
    // cannot tell whether eviction tracks age or incentive -- which is the
    // reporter's actual question.
    const rows = index["53"];
    assert.equal(rows.find((r) => r[3] === 200)![5], 100);
    assert.equal(rows.find((r) => r[3] === 350)![5], 150);
  });

  test("a slot that never turned over produces no event", () => {
    // uid 9 registered once. Emitting a row for it would invent an eviction.
    assert.equal(
      index["53"].some((r) => r[0] === 9),
      false,
    );
  });

  test("the unattributed population is EXCLUDED, not guessed at", () => {
    // Only the events with an observed predecessor appear. The first
    // registration on each slot has none, and those are what
    // `unattributed_registrations` counts -- the same lower-bound caveat the
    // scalar carries, applied to the events.
    assert.ok(
      derived.unattributed > 0,
      "fixture should have unattributed rows",
    );
    const total = Object.values(index).reduce((n, rows) => n + rows.length, 0);
    assert.equal(total, derived.events.length);
    assert.ok(
      total < derived.registrations,
      "events must be fewer than registrations -- they are a lower bound",
    );
  });

  test("two evictions in one observation break the tie by BLOCK", () => {
    // The poller stamps a whole batch with one observed_at, so equal timestamps
    // are the norm, not an edge case. Falling back to insertion order would
    // make the newest-first contract silently untrue inside every batch.
    const stamped = now - 3 * DAY;
    const derived = deriveDeregistrations(
      [
        {
          netuid: 5,
          uid: 0,
          hotkey: "hk-1",
          block_number: 10,
          event_index: 1,
          observed_at: now - 9 * DAY,
        },
        {
          netuid: 5,
          uid: 1,
          hotkey: "hk-2",
          block_number: 11,
          event_index: 1,
          observed_at: now - 9 * DAY,
        },
        {
          netuid: 5,
          uid: 0,
          hotkey: "hk-3",
          block_number: 400,
          event_index: 1,
          observed_at: stamped,
        },
        {
          netuid: 5,
          uid: 1,
          hotkey: "hk-4",
          block_number: 900,
          event_index: 1,
          observed_at: stamped,
        },
      ],
      { since: now - 30 * DAY },
    );
    const rows = deregistrationsByNetuidUid(derived.events)["5"]!;
    assert.deepEqual(
      rows.map((r) => r[3]),
      [900, 400],
      "same observed_at must order by block, highest first",
    );
  });

  test("a same-hotkey re-registration is not an eviction of itself", () => {
    const same = deriveDeregistrations(
      [
        {
          netuid: 1,
          uid: 0,
          hotkey: "hk-X",
          block_number: 10,
          event_index: 1,
          observed_at: now - 9 * DAY,
        },
        {
          netuid: 1,
          uid: 0,
          hotkey: "hk-X",
          block_number: 20,
          event_index: 1,
          observed_at: now - 8 * DAY,
        },
      ],
      { since: now - 30 * DAY },
    );
    assert.deepEqual(deregistrationsByNetuidUid(same.events), {});
  });
});
