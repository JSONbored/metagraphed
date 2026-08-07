// Row selection over a metagraph snapshot (#9872).
//
// The reporter's case, in numbers measured against subnet 53's real snapshot
// on 2026-08-07 (256 neurons, 98,081 bytes): a single-hotkey lookup is 517
// bytes, `sort_by: incentive` + `limit: 12` is 4,972. The tests below pin the
// SEMANTICS that make those numbers correct rather than the numbers, which
// move with the chain.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { selectNeuronRows } from "../src/metagraph-neurons.ts";
import { NEURON_SORT_FIELD_NAMES } from "../schemas-src/mcp-tools/shared.ts";
import { NeuronSchema } from "../schemas-src/routes/subnet-metagraph.ts";
import type { Row } from "./row-type.ts";

// Five neurons covering every branch the selector has: a zero incentive, a
// null one, a duplicate value (to force the uid tiebreak), and an inactive row.
function snapshot(): Row {
  return {
    schema_version: 1,
    netuid: 53,
    neuron_count: 5,
    captured_at: "2026-08-07T16:18:31.183Z",
    block_number: 8793568,
    neurons: [
      { uid: 0, hotkey: "hk-a", active: true, incentive: 0, stake_tao: 5 },
      { uid: 1, hotkey: "hk-b", active: true, incentive: 0.5, stake_tao: 1 },
      { uid: 2, hotkey: "hk-c", active: false, incentive: 0.9, stake_tao: 3 },
      { uid: 3, hotkey: "hk-d", active: true, incentive: null, stake_tao: 9 },
      { uid: 4, hotkey: "hk-e", active: true, incentive: 0.5, stake_tao: 2 },
    ],
  };
}

const uids = (data: Row) => (data.neurons as Row[]).map((n) => n.uid);

describe("selectNeuronRows (#9872)", () => {
  test("an empty selection returns the very same object", () => {
    const data = snapshot();
    // Identity, not deep equality: the unfiltered response must stay
    // byte-identical for every existing caller, and a fresh object that
    // merely looks the same would still have gained total_neuron_count.
    assert.equal(selectNeuronRows(data, {}), data);
    assert.equal(
      Object.hasOwn(selectNeuronRows(data, {}), "total_neuron_count"),
      false,
    );
  });

  test("hotkeys returns only those rows, and an unregistered one is absent rather than an error", () => {
    const picked = selectNeuronRows(snapshot(), {
      hotkeys: ["hk-c", "hk-not-registered"],
    });
    assert.deepEqual(uids(picked), [2]);
    assert.equal(picked.neuron_count, 1);
    // The whole point of the pair: 1 of 5, not a bare 1 that reads as the
    // size of the subnet.
    assert.equal(picked.total_neuron_count, 5);
  });

  test("active distinguishes false from absent", () => {
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { active: true })),
      [0, 1, 3, 4],
    );
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { active: false })),
      [2],
    );
    // Absent must not narrow to the false rows -- the tri-state bug this
    // helper's optionalNullableBoolean exists to prevent.
    assert.deepEqual(uids(selectNeuronRows(snapshot(), {})), [0, 1, 2, 3, 4]);
  });

  test("a floor is inclusive, and a null incentive never clears it", () => {
    // min_incentive: 0 keeps the zero population (uid 0) -- documented, and
    // the reason the tool description points at sort_by+limit instead for
    // "only the neurons actually earning".
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { minIncentive: 0 })),
      [0, 1, 2, 4],
    );
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { minIncentive: 0.5 })),
      [1, 2, 4],
    );
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { minIncentive: 1 })),
      [],
    );
  });

  test("null sorts last in BOTH directions, and ties break by uid", () => {
    // uid 3 is the null; it trails in each direction rather than leading the
    // ascending one, which is the difference between "unranked" and "worst".
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { sortBy: "incentive" })),
      [2, 1, 4, 0, 3],
    );
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { sortBy: "incentive", order: "asc" })),
      [0, 1, 4, 2, 3],
    );
    // uid 1 and uid 4 both sit at 0.5 and keep uid order in both directions.
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { sortBy: "incentive" })).slice(1, 3),
      [1, 4],
    );
  });

  test("sort defaults to descending, because a sort here asks who is on top", () => {
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { sortBy: "stake_tao" })),
      uids(
        selectNeuronRows(snapshot(), { sortBy: "stake_tao", order: "desc" }),
      ),
    );
    assert.deepEqual(
      uids(selectNeuronRows(snapshot(), { sortBy: "stake_tao" })),
      [3, 0, 2, 4, 1],
    );
  });

  test("limit applies after the filter and the sort", () => {
    const top = selectNeuronRows(snapshot(), {
      active: true,
      sortBy: "incentive",
      limit: 2,
    });
    // uid 2 has the highest incentive but is inactive, so the filter drops it
    // BEFORE the sort picks a top two -- a limit applied first would have
    // returned it.
    assert.deepEqual(uids(top), [1, 4]);
    assert.equal(top.neuron_count, 2);
    assert.equal(top.total_neuron_count, 5);
  });

  test("a sort alone reports no total_neuron_count, because it removed nothing", () => {
    const sorted = selectNeuronRows(snapshot(), { sortBy: "incentive" });
    assert.equal(sorted.neuron_count, 5);
    assert.equal(Object.hasOwn(sorted, "total_neuron_count"), false);
    // A limit that is larger than the snapshot is also not a narrowing.
    const generous = selectNeuronRows(snapshot(), { limit: 500 });
    assert.equal(Object.hasOwn(generous, "total_neuron_count"), false);
  });

  test("neuron_count always equals neurons.length", () => {
    for (const selection of [
      {},
      { hotkeys: ["hk-a"] },
      { active: true },
      { minIncentive: 0.5 },
      { sortBy: "stake_tao", limit: 3 },
      { hotkeys: ["hk-nobody"] },
    ]) {
      const result = selectNeuronRows(snapshot(), selection);
      assert.equal(result.neuron_count, (result.neurons as Row[]).length);
    }
  });

  test("a non-finite sort value is treated as null, not as a number", () => {
    // NaN/Infinity compare false against everything, so letting one through
    // would make the whole order depend on where it happened to sit. It takes
    // the same last-place branch a null does.
    const rows = [
      { uid: 0, stake_tao: 2 },
      { uid: 1, stake_tao: Number.NaN },
      { uid: 2, stake_tao: Number.POSITIVE_INFINITY },
      { uid: 3, stake_tao: 7 },
    ];
    assert.deepEqual(
      uids(selectNeuronRows({ neurons: rows }, { sortBy: "stake_tao" })),
      [3, 0, 1, 2],
    );
  });

  test("rows with no uid still order deterministically", () => {
    // The tiebreak reads `uid`; a row without one must not make the sort
    // depend on arrival order. Two of them tie with each other and trail the
    // rows that have one.
    const rows = [
      { hotkey: "hk-x", stake_tao: 1 },
      { uid: 5, stake_tao: 1 },
      { hotkey: "hk-y", stake_tao: 1 },
    ];
    const sorted = selectNeuronRows({ neurons: rows }, { sortBy: "stake_tao" });
    assert.deepEqual(
      (sorted.neurons as Row[]).map((row) => row.uid ?? row.hotkey),
      [5, "hk-x", "hk-y"],
    );
  });

  test("a payload with no neurons array is passed through untouched", () => {
    // buildNeuronDetail's single-row shape goes through the same handler path
    // on the hotkey branch; it must not acquire a neurons array here.
    const detail = { schema_version: 1, netuid: 53, neuron: null };
    assert.equal(selectNeuronRows(detail, { limit: 1 }), detail);
  });
});

describe("NEURON_SORT_FIELD_NAMES (#9872)", () => {
  test("is every numeric field of NeuronSchema, and only those", () => {
    // Asserted against the schema rather than against a copied list: the
    // point of deriving it is that a numeric field added to the contract
    // becomes sortable with no list to update, and a test carrying its own
    // copy would defeat that on the first addition.
    const numericByName = Object.entries(NeuronSchema.shape).filter(
      ([, schema]) => {
        let cur = schema as {
          _zod?: { def?: { type?: string; innerType?: unknown } };
        };
        for (let depth = 0; depth < 8; depth += 1) {
          const type = cur?._zod?.def?.type;
          if (
            type === "optional" ||
            type === "nullable" ||
            type === "default"
          ) {
            cur = cur._zod!.def!.innerType as typeof cur;
            continue;
          }
          return type === "number";
        }
        return false;
      },
    );
    assert.deepEqual(
      [...NEURON_SORT_FIELD_NAMES].sort(),
      numericByName.map(([name]) => name).sort(),
    );
    // A negative assertion passes on an empty set, so prove the set is real
    // and that a known string field really is excluded (#9689).
    assert.ok(NEURON_SORT_FIELD_NAMES.length >= 10);
    assert.equal(NEURON_SORT_FIELD_NAMES.includes("hotkey"), false);
    assert.equal(NEURON_SORT_FIELD_NAMES.includes("incentive"), true);
  });

  test("every sortable name actually sorts", () => {
    // Guards the case where the derivation drifts from the comparator -- a
    // published enum value that silently no-ops is the defect #9750 fixed on
    // list_gaps, and this is the same shape.
    for (const field of NEURON_SORT_FIELD_NAMES) {
      // When `field` IS "uid" the two keys collapse into one, so the rows
      // carry the sort values as their uids -- hence the second expectation.
      const rows = [
        { uid: 0, [field]: 1 },
        { uid: 1, [field]: 3 },
        { uid: 2, [field]: 2 },
      ];
      const sorted = selectNeuronRows({ neurons: rows }, { sortBy: field });
      assert.deepEqual(
        uids(sorted),
        field === "uid" ? [3, 2, 1] : [1, 2, 0],
        `sort_by: ${field} did not order the rows`,
      );
    }
  });
});
