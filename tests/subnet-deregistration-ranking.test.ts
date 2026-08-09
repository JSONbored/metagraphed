// The chain's own subnet pruning order (#10285).
//
// The assertions concentrate on the four clauses of
// `Subtensor::get_network_to_prune()`, because each one is a place where a
// plausible implementation gives a different answer than the chain:
//
//   1. root is excluded;
//   2. an immune subnet is not ranked AT ALL, not ranked last;
//   3. a Stable subnet compares at a flat 1.0, not at its moving price;
//   4. a price tie goes to the EARLIER registration.
//
// Clause 2 is the one that matters most in practice: measured on mainnet, a
// price-only sort put an immune subnet at position one.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  DEREGISTRATION_FIELD_SOURCES,
  ROOT_NETUID,
  STABLE_MECHANISM,
  STABLE_MECHANISM_PRICE,
  comparisonPrice,
  projectDeregistrationRanking,
  rankDeregistration,
  type DeregistrationCandidateInput,
} from "../src/subnet-deregistration-ranking.ts";

const IMMUNITY = 864_000;
const BLOCK = 8_800_000;
/** Registered long enough ago to be prunable at BLOCK. */
const OLD = 1_000_000;

const candidate = (
  over: Partial<DeregistrationCandidateInput> & { netuid: number },
): DeregistrationCandidateInput => ({
  moving_price: 0.005,
  registered_at_block: OLD,
  subnet_mechanism: 1,
  ...over,
});

function rank(candidates: DeregistrationCandidateInput[]) {
  const result = rankDeregistration({
    block: BLOCK,
    networkImmunityPeriod: IMMUNITY,
    candidates,
  });
  assert.equal(result.ok, true);
  return result.ok ? result.ranking : null!;
}

describe("the pallet's four clauses", () => {
  test("root is never a candidate, ranked or immune", () => {
    const out = rank([
      candidate({ netuid: ROOT_NETUID, moving_price: 0 }),
      candidate({ netuid: 5 }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [5],
    );
    assert.equal(out.immune.length, 0);
  });

  test("an immune subnet is EXCLUDED from the order, not placed last", () => {
    // The mainnet failure this module exists for: netuid 86 read a moving
    // price of exactly 0 -- the most prunable value there is -- and heads any
    // price sort, but cannot be deregistered at all.
    const out = rank([
      candidate({
        netuid: 86,
        moving_price: 0,
        registered_at_block: BLOCK - 1,
      }),
      candidate({ netuid: 70, moving_price: 0.0015 }),
    ]);
    assert.equal(out.next_to_deregister, 70, "the immune subnet must not win");
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [70],
    );
    assert.deepEqual(
      out.immune.map((e) => e.netuid),
      [86],
    );
    // Null rank, not a large one: "cannot be pruned" is a different claim from
    // "pruned last", and a number would be read as the latter.
    assert.equal(out.immune[0]!.rank, null);
  });

  test("a Stable subnet compares at 1.0, not at its moving price", () => {
    // Real alpha prices are ~0.008, so the flat 1.0 moves a Stable subnet from
    // the TOP of a price sort to the bottom.
    const out = rank([
      candidate({
        netuid: 3,
        moving_price: 0.000_001,
        subnet_mechanism: STABLE_MECHANISM,
      }),
      candidate({ netuid: 9, moving_price: 0.5 }),
    ]);
    assert.equal(out.next_to_deregister, 9);
    assert.equal(out.ranked[1]!.netuid, 3);
    assert.equal(out.ranked[1]!.comparison_price, STABLE_MECHANISM_PRICE);
    // The raw read is published beside it, so the substitution is visible.
    assert.equal(out.ranked[1]!.moving_price, 0.000_001);
  });

  test("a price tie goes to the EARLIER registration", () => {
    const out = rank([
      candidate({
        netuid: 11,
        moving_price: 0.002,
        registered_at_block: 900_000,
      }),
      candidate({
        netuid: 12,
        moving_price: 0.002,
        registered_at_block: 100_000,
      }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [12, 11],
      "inverting this hands the older subnet's turn to the newer one",
    );
  });

  test("netuid breaks a tie the pallet's two keys cannot", () => {
    // Not the pallet's rule -- it iterates a map and takes the first strict
    // improvement, so equal price AND equal height is order-dependent there.
    // Ours is deterministic instead, because a ranking that reshuffles between
    // identical requests is unreadable.
    const out = rank([
      candidate({ netuid: 40, moving_price: 0.002, registered_at_block: 5 }),
      candidate({ netuid: 20, moving_price: 0.002, registered_at_block: 5 }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [20, 40],
    );
  });
});

describe("immunity arithmetic", () => {
  test("the boundary block is prunable, not immune", () => {
    // `current_block < registered_at + immunity` -- strictly less. At exactly
    // the boundary the subnet is prunable, and an off-by-one here protects a
    // subnet the chain would take.
    const out = rank([
      candidate({ netuid: 1, registered_at_block: BLOCK - IMMUNITY }),
      candidate({ netuid: 2, registered_at_block: BLOCK - IMMUNITY + 1 }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [1],
    );
    assert.deepEqual(
      out.immune.map((e) => e.netuid),
      [2],
    );
    assert.equal(out.immune[0]!.blocks_until_prunable, 1);
  });

  test("immune subnets are ordered by when they JOIN the ranking", () => {
    const out = rank([
      candidate({ netuid: 1, registered_at_block: BLOCK - 10 }),
      candidate({ netuid: 2, registered_at_block: BLOCK - 100_000 }),
      candidate({ netuid: 3, registered_at_block: BLOCK - 1 }),
    ]);
    assert.deepEqual(
      out.immune.map((e) => e.netuid),
      [2, 1, 3],
      "soonest to lose protection first",
    );
  });

  test("a prunable subnet reports 0 blocks and a null until-block", () => {
    const out = rank([candidate({ netuid: 7 })]);
    assert.equal(out.ranked[0]!.immune, false);
    assert.equal(out.ranked[0]!.immune_until_block, null);
    assert.equal(out.ranked[0]!.blocks_until_prunable, 0);
  });

  test("a zero immunity period protects nobody", () => {
    // Legitimate configuration, and it must not be read as "unavailable" --
    // the guard is on readability, not truthiness.
    const result = rankDeregistration({
      block: BLOCK,
      networkImmunityPeriod: 0,
      candidates: [candidate({ netuid: 4, registered_at_block: BLOCK - 1 })],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.ranking.ranked.length, 1);
  });
});

describe("comparisonPrice", () => {
  test("an absent moving price reads 0, the most prunable value", () => {
    // The pallet uses ValueQuery, so an absent entry IS zero there. Dropping
    // such a subnet would remove the single likeliest victim from the order.
    assert.equal(
      comparisonPrice({
        netuid: 1,
        moving_price: null,
        registered_at_block: 0,
        subnet_mechanism: 1,
      }),
      0,
    );
  });

  test("Stable wins over the price even when the price is absent", () => {
    assert.equal(
      comparisonPrice({
        netuid: 1,
        moving_price: null,
        registered_at_block: 0,
        subnet_mechanism: STABLE_MECHANISM,
      }),
      STABLE_MECHANISM_PRICE,
    );
  });
});

describe("declining beats guessing", () => {
  test("no immunity period is a decline, not an unprotected ranking", () => {
    const result = rankDeregistration({
      block: BLOCK,
      networkImmunityPeriod: null,
      candidates: [candidate({ netuid: 1 })],
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "immunity_period_unavailable",
    });
  });

  test("no block is a decline -- immunity cannot be judged without one", () => {
    for (const block of [null, undefined, 0, Number.NaN]) {
      const result = rankDeregistration({
        block,
        networkImmunityPeriod: IMMUNITY,
        candidates: [candidate({ netuid: 1 })],
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "block_unavailable");
    }
  });

  test("a negative immunity period is refused", () => {
    const result = rankDeregistration({
      block: BLOCK,
      networkImmunityPeriod: -1,
      candidates: [candidate({ netuid: 1 })],
    });
    assert.equal(
      result.ok === false && result.reason,
      "immunity_period_unavailable",
    );
  });

  test("an empty candidate set declines rather than reporting a healthy zero", () => {
    const result = rankDeregistration({
      block: BLOCK,
      networkImmunityPeriod: IMMUNITY,
      candidates: [],
    });
    assert.equal(result.ok === false && result.reason, "no_candidates");
  });

  test("a set that is only root declines too", () => {
    // Root is filtered before the count, so this is genuinely no candidates
    // rather than one that happens to be excluded.
    const result = rankDeregistration({
      block: BLOCK,
      networkImmunityPeriod: IMMUNITY,
      candidates: [candidate({ netuid: ROOT_NETUID })],
    });
    assert.equal(result.ok === false && result.reason, "no_candidates");
  });

  test("a malformed netuid is skipped, not ranked", () => {
    const out = rank([
      candidate({ netuid: 1.5 }),
      candidate({ netuid: -3 }),
      candidate({ netuid: 8 }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [8],
    );
  });

  test("a non-finite registration height falls back to 0, never immune", () => {
    const out = rank([
      candidate({ netuid: 2, registered_at_block: null }),
      candidate({ netuid: 3, moving_price: 0.9 }),
    ]);
    assert.equal(out.ranked[0]!.registered_at_block, 0);
    assert.equal(out.ranked[0]!.immune, false);
  });

  test("a null mechanism is treated as Dynamic, not Stable", () => {
    // Defaulting the other way would substitute 1.0 and bury a genuinely
    // cheap subnet at the bottom of the order.
    const out = rank([
      candidate({ netuid: 6, subnet_mechanism: null, moving_price: 0.01 }),
    ]);
    assert.equal(out.ranked[0]!.subnet_mechanism, 0);
    assert.equal(out.ranked[0]!.comparison_price, 0.01);
  });
});

describe("ranks", () => {
  test("are contiguous from 1 and follow comparison_price", () => {
    const out = rank([
      candidate({ netuid: 1, moving_price: 0.03 }),
      candidate({ netuid: 2, moving_price: 0.01 }),
      candidate({ netuid: 3, moving_price: 0.02 }),
    ]);
    assert.deepEqual(
      out.ranked.map((e) => [e.rank, e.netuid]),
      [
        [1, 2],
        [2, 3],
        [3, 1],
      ],
    );
    assert.equal(out.next_to_deregister, 2);
  });

  test("next_to_deregister is null when everything is immune", () => {
    const out = rank([
      candidate({ netuid: 1, registered_at_block: BLOCK - 1 }),
      candidate({ netuid: 2, registered_at_block: BLOCK - 2 }),
    ]);
    assert.equal(out.ranked.length, 0);
    assert.equal(out.next_to_deregister, null);
  });
});

describe("projectDeregistrationRanking", () => {
  const blob = (over: Record<string, unknown> = {}) => ({
    chain_state: {
      block: BLOCK,
      network_immunity_period: IMMUNITY,
      ...((over.chain_state as Record<string, unknown>) ?? {}),
    },
    subnets: over.subnets ?? [
      {
        netuid: 1,
        moving_price_pinned: 0.004,
        registered_at_block: OLD,
        subnet_mechanism: 1,
      },
      {
        netuid: 2,
        moving_price_pinned: 0.001,
        registered_at_block: OLD,
        subnet_mechanism: 1,
      },
    ],
  });

  test("projects the ranking with its counts and provenance", () => {
    const out = projectDeregistrationRanking(blob())!;
    assert.equal(out.next_to_deregister, 2);
    assert.equal(out.ranked_count, 2);
    assert.equal(out.immune_count, 0);
    assert.equal(out.schema_version, 1);
    assert.equal(out.field_sources, DEREGISTRATION_FIELD_SOURCES);
  });

  test("null -- never a partial body -- without a chain_state", () => {
    assert.equal(projectDeregistrationRanking({ subnets: [] }), null);
    assert.equal(projectDeregistrationRanking({ chain_state: null }), null);
    assert.equal(projectDeregistrationRanking(null), null);
    assert.equal(projectDeregistrationRanking(undefined), null);
  });

  test("null when the blob predates the immunity read", () => {
    // The R2 fallback tier still holds these. Serving them as a ranking would
    // publish an order computed without the clause that decides it.
    const out = projectDeregistrationRanking(
      blob({ chain_state: { network_immunity_period: undefined } }),
    );
    assert.equal(out, null);
  });

  test("a row missing the new fields still ranks, at the pallet's defaults", () => {
    const out = projectDeregistrationRanking(
      blob({ subnets: [{ netuid: 4, moving_price_pinned: 0.002 }] }),
    )!;
    assert.equal(out.ranked[0]!.registered_at_block, 0);
    assert.equal(out.ranked[0]!.subnet_mechanism, 0);
  });

  test("rows without a netuid are skipped", () => {
    const out = projectDeregistrationRanking(
      blob({
        subnets: [
          { moving_price_pinned: 0 },
          { netuid: 5, moving_price_pinned: 0.1 },
        ],
      }),
    )!;
    assert.deepEqual(
      out.ranked.map((e) => e.netuid),
      [5],
    );
  });

  test("a non-array subnets field is no candidates, not a crash", () => {
    assert.equal(projectDeregistrationRanking(blob({ subnets: "nope" })), null);
  });

  test("field_sources marks comparison_price OURS, not the chain's", () => {
    // It equals a storage read on every Dynamic subnet, which is exactly why
    // it would be mislabelled `measured` -- on a Stable subnet it is a
    // constant the pallet substitutes.
    assert.equal(
      DEREGISTRATION_FIELD_SOURCES.comparison_price.kind,
      "reconstructed",
    );
    assert.equal(
      DEREGISTRATION_FIELD_SOURCES.moving_price.storage,
      "SubtensorModule.SubnetMovingPrice",
    );
    assert.equal(
      DEREGISTRATION_FIELD_SOURCES.network_immunity_period.storage,
      "SubtensorModule.NetworkImmunityPeriod",
    );
  });
});
