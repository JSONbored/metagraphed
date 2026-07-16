import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatNeuron,
  buildSubnetMetagraph,
  buildSubnetValidators,
  buildGlobalValidators,
  buildNeuronDetail,
  buildValidatorDetail,
  composeValidatorComparison,
  overlayFeaturedValidators,
  loadSubnetValidators,
  loadGlobalValidators,
  loadValidatorDetail,
} from "../src/metagraph-neurons.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// A D1 `neurons` row (booleans as 0/1 INTEGER, stake/emission already TAO floats).
const ROW = {
  uid: 0,
  hotkey: "5Hk1",
  coldkey: "5Co1",
  active: 1,
  validator_permit: 1,
  rank: 1,
  trust: 0.5,
  validator_trust: 0.99,
  consensus: 0.4,
  incentive: 0.1,
  dividends: 0.2,
  emission_tao: 22.1,
  stake_tao: 1000.5,
  registered_at_block: 6702485,
  is_immunity_period: 0,
  axon: "1.2.3.4:8091",
  block_number: 8454388,
  captured_at: 1750000000000,
};
const MINER = { ...ROW, uid: 5, validator_permit: 0, hotkey: "5Hk5" };
const NEURON_CSV_HEADER =
  "uid,hotkey,coldkey,active,validator_permit,rank,trust,validator_trust,consensus,incentive,dividends,emission_tao,stake_tao,registered_at_block,is_immunity_period,axon";
const MOVERS_CSV_HEADER =
  "netuid,stake_start_tao,stake_end_tao,stake_delta_tao,stake_pct_change,emission_start_tao,emission_end_tao,emission_delta_tao,emission_pct_change,validators_start,validators_end,validators_delta,neurons_start,neurons_end,neurons_delta";
const GLOBAL_VALIDATOR_CSV_HEADER =
  "hotkey,coldkey,coldkey_count,subnet_count,uid_count,total_stake_tao,root_stake_tao,alpha_stake_tao,total_emission_tao,nominator_count,apy_estimate,apy_estimate_eligible_subnet_count,stake_dominance,avg_validator_trust,max_validator_trust,latest_captured_at,latest_block_number,subnets";

describe("metagraph-neurons builders", () => {
  test("formatNeuron coerces 0/1 INTEGER flags to real booleans", () => {
    const n = formatNeuron(ROW);
    assert.equal(n.active, true);
    assert.equal(n.validator_permit, true);
    assert.equal(n.is_immunity_period, false);
    assert.equal(n.stake_tao, 1000.5);
    assert.equal(n.hotkey, "5Hk1");
    assert.equal(n.axon, "1.2.3.4:8091");
  });

  test("formatNeuron is null-safe", () => {
    assert.equal(formatNeuron(null), null);
    assert.equal(formatNeuron(undefined), null);
  });

  test("formatNeuron defaults every missing field to null/false", () => {
    // Exercises the ?? null + Boolean(falsy) branches (sparse chain row).
    const n = formatNeuron({ uid: 3 });
    assert.equal(n.uid, 3);
    assert.equal(n.hotkey, null);
    assert.equal(n.coldkey, null);
    assert.equal(n.rank, null);
    assert.equal(n.trust, null);
    assert.equal(n.validator_trust, null);
    assert.equal(n.consensus, null);
    assert.equal(n.incentive, null);
    assert.equal(n.dividends, null);
    assert.equal(n.emission_tao, null);
    assert.equal(n.stake_tao, null);
    assert.equal(n.registered_at_block, null);
    assert.equal(n.axon, null);
    assert.equal(n.active, false);
    assert.equal(n.validator_permit, false);
    assert.equal(n.is_immunity_period, false);
  });

  test("formatNeuron coerces string-typed D1 0/1 flags to real booleans", () => {
    // D1 can return an INTEGER flag column as a numeric string ("0"/"1"); the
    // bare Boolean() this replaced would have leaked Boolean("0") === true
    // and Boolean("") === false, so a string "0" flag would silently surface
    // as `active: true`. Same class as the formatRegistration fix in #2487.
    const n = formatNeuron({
      active: "0",
      validator_permit: "1",
      is_immunity_period: "0",
    });
    assert.equal(n.active, false);
    assert.equal(n.validator_permit, true);
    assert.equal(n.is_immunity_period, false);
  });

  test("formatNeuron coerces string-typed uid/registered_at_block, stake/emission, and ratio cells", () => {
    // D1 can return INTEGER / REAL columns as numeric strings ("3" not 3,
    // "1000.5" not 1000.5); the bare `?? null` pass-through this replaced would
    // have leaked strings into the API payload. Same shape as the coercion in
    // blocks.mjs (#2435), extrinsics.mjs (#2439), and account-events.mjs
    // (#2481, #2489). stake/emission additionally round to rao precision so
    // accumulated IEEE-754 float noise never reaches the payload. Ratio fields
    // use nullableNumber + round, matching buildGlobalValidators (#2611).
    const n = formatNeuron({
      uid: "3",
      registered_at_block: "6702485",
      stake_tao: "1000.5",
      emission_tao: "22.123456789",
      rank: "12",
      trust: "0.25",
      validator_trust: "0.4",
      consensus: "0.88",
      incentive: "0.01",
      dividends: "0.02",
    });
    assert.equal(n.uid, 3);
    assert.equal(typeof n.uid, "number");
    assert.equal(n.registered_at_block, 6702485);
    assert.equal(typeof n.registered_at_block, "number");
    assert.equal(n.stake_tao, 1000.5);
    assert.equal(typeof n.stake_tao, "number");
    assert.equal(n.emission_tao, 22.123456789);
    assert.equal(typeof n.emission_tao, "number");
    assert.equal(n.rank, 12);
    assert.equal(typeof n.rank, "number");
    assert.equal(n.trust, 0.25);
    assert.equal(typeof n.trust, "number");
    assert.equal(n.validator_trust, 0.4);
    assert.equal(n.consensus, 0.88);
    assert.equal(n.incentive, 0.01);
    assert.equal(n.dividends, 0.02);
  });

  test("formatNeuron nulls invalid or absent ratio cells", () => {
    const n = formatNeuron({
      rank: null,
      trust: "not-a-number",
      validator_trust: undefined,
    });
    assert.equal(n.rank, null);
    assert.equal(n.trust, null);
    assert.equal(n.validator_trust, null);
  });

  test("formatNeuron coerces string-typed REAL score cells (rank/trust/consensus/…)", () => {
    // rank/trust/validator_trust/consensus/incentive/dividends are nullable REAL
    // columns that D1 can surface as numeric strings ("0.5" not 0.5). #2493 left
    // them on a bare `?? null` pass-through while coercing the other numeric
    // fields, so a string cell leaked straight into the number-typed API payload.
    const n = formatNeuron({
      rank: "0.75",
      trust: "0.5",
      validator_trust: "0.99",
      consensus: "0.4",
      incentive: "0.1",
      dividends: "0.2",
    });
    assert.equal(n.rank, 0.75);
    assert.equal(typeof n.rank, "number");
    assert.equal(n.trust, 0.5);
    assert.equal(n.validator_trust, 0.99);
    assert.equal(n.consensus, 0.4);
    assert.equal(n.incentive, 0.1);
    assert.equal(n.dividends, 0.2);
    assert.equal(typeof n.dividends, "number");
  });

  test("formatNeuron keeps null contract for explicit null score cells", () => {
    // nullableNumber(null) === 0 (Number(null) is 0, which is finite), so the
    // score fields need the same `== null` guard as uid/stake/emission — an
    // explicit null REAL cell must serialize as null, not 0.
    const n = formatNeuron({
      rank: null,
      trust: null,
      validator_trust: null,
      consensus: null,
      incentive: null,
      dividends: null,
    });
    assert.equal(n.rank, null);
    assert.equal(n.trust, null);
    assert.equal(n.validator_trust, null);
    assert.equal(n.consensus, null);
    assert.equal(n.incentive, null);
    assert.equal(n.dividends, null);
  });

  test("formatNeuron rejects blank score cells that coerce to 0 (not rank/trust 0)", () => {
    // Mirrors the blank-cell guard in account-events.mjs (#3031): Number("") is 0.
    for (const blank of ["", "   "]) {
      const n = formatNeuron({
        rank: blank,
        trust: blank,
        validator_trust: blank,
        consensus: blank,
        incentive: blank,
        dividends: blank,
      });
      assert.equal(n.rank, null, `rank for ${JSON.stringify(blank)}`);
      assert.equal(n.trust, null, `trust for ${JSON.stringify(blank)}`);
      assert.equal(
        n.validator_trust,
        null,
        `validator_trust for ${JSON.stringify(blank)}`,
      );
      assert.equal(n.consensus, null, `consensus for ${JSON.stringify(blank)}`);
      assert.equal(n.incentive, null, `incentive for ${JSON.stringify(blank)}`);
      assert.equal(n.dividends, null, `dividends for ${JSON.stringify(blank)}`);
    }
    // A literal zero score is still valid — only blank strings are rejected.
    const zero = formatNeuron({ rank: 0, trust: "0" });
    assert.equal(zero.rank, 0);
    assert.equal(zero.trust, 0);
  });

  test("formatNeuron rounds stake_tao / emission_tao to rao precision (no IEEE-754 leak)", () => {
    // Regression for the Gittensory Orb follow-up blocker on #2503: stake_tao /
    // emission_tao must be rounded to 1e-9 (rao) precision so a noisy REAL
    // D1 cell (e.g. 22.1234567894) does not leak accumulated IEEE-754 noise
    // into the API payload. Mirrors toTaoOrNull in account-events.mjs and
    // roundTao in chain-analytics.mjs.
    const n = formatNeuron({
      stake_tao: "22.1234567894",
      emission_tao: "1000.50000000004",
    });
    // 22.1234567894 → 22.123456789 (9 dp); 1000.50000000004 → 1000.5
    assert.equal(n.stake_tao, 22.123456789);
    assert.equal(n.emission_tao, 1000.5);
    // And no extra precision sneaks past rao.
    assert.equal(String(n.stake_tao).split(".")[1]?.length ?? 0, 9);
    assert.equal(String(n.emission_tao).split(".")[1]?.length <= 9, true);
  });

  test("formatNeuron keeps null contract for explicit null cells (regression)", () => {
    // Regression for the Gittensory Orb blocker on #2503: the upstream
    // nonNegativeInt / nullableNumber helpers added in #2493 do not have
    // explicit `value == null` guards, so Number(null) === 0 leaks as 0
    // instead of falling through to null. A real D1 row with explicit null
    // cells must serialize as null (matches the missing-key behavior proven
    // by the existing `defaults every missing field to null/false` test).
    const n = formatNeuron({
      uid: null,
      registered_at_block: null,
      stake_tao: null,
      emission_tao: null,
    });
    assert.equal(n.uid, null);
    assert.equal(n.registered_at_block, null);
    assert.equal(n.stake_tao, null);
    assert.equal(n.emission_tao, null);
  });

  test("formatNeuron rejects blank integer cells that coerce to 0 (not uid/block 0)", () => {
    // Mirrors the blank-cell guard in chain-analytics.mjs (#3019): Number("") is 0.
    for (const blank of ["", "   "]) {
      const n = formatNeuron({
        uid: blank,
        registered_at_block: blank,
      });
      assert.equal(n.uid, null, `uid for ${JSON.stringify(blank)}`);
      assert.equal(
        n.registered_at_block,
        null,
        `registered_at_block for ${JSON.stringify(blank)}`,
      );
    }
  });

  test("buildSubnetMetagraph nulls blank snapshot block_number cells (not block 0)", () => {
    for (const blank of ["", "   "]) {
      const data = buildSubnetMetagraph(
        [{ ...ROW, block_number: blank, uid: 1 }],
        7,
      );
      assert.equal(
        data.block_number,
        null,
        `block_number for ${JSON.stringify(blank)}`,
      );
    }
  });

  test("buildSubnetMetagraph stamps count + ISO captured_at", () => {
    const data = buildSubnetMetagraph([ROW, MINER], 7);
    assert.equal(data.netuid, 7);
    assert.equal(data.neuron_count, 2);
    assert.equal(data.block_number, 8454388);
    assert.equal(typeof data.captured_at, "string"); // epoch ms → ISO
    assert.equal(data.neurons.length, 2);
    // empty snapshot → schema-stable empty payload (cold-store safe).
    const empty = buildSubnetMetagraph([], 7);
    assert.equal(empty.neuron_count, 0);
    assert.equal(empty.captured_at, null);
    assert.deepEqual(empty.neurons, []);
  });

  test("buildSubnetValidators counts validators", () => {
    const data = buildSubnetValidators([ROW], 7);
    assert.equal(data.validator_count, 1);
    assert.equal(data.validators[0].validator_permit, true);
  });

  test("formatNeuron omits `featured` when no featuredHotkeys set is passed", () => {
    // buildSubnetMetagraph/buildNeuronDetail/buildValidatorDetail never pass a
    // set, so metagraph/neuron-detail/validator-detail responses keep their
    // existing Neuron shape unchanged (#5166).
    const n = formatNeuron(ROW);
    assert.equal("featured" in n, false);
  });

  test("formatNeuron sets `featured` true/false by hotkey when a set is passed", () => {
    const featured = new Set(["5Hk1"]);
    assert.equal(formatNeuron(ROW, featured).featured, true);
    assert.equal(formatNeuron(MINER, featured).featured, false);
    // An empty (but real) set still yields a real boolean, not an omission.
    assert.equal(formatNeuron(ROW, new Set()).featured, false);
  });

  test("buildSubnetValidators always includes `featured`, matched by hotkey", () => {
    const withNoFeatured = buildSubnetValidators([ROW], 7);
    assert.equal(withNoFeatured.validators[0].featured, false);

    const withFeatured = buildSubnetValidators([ROW], 7, {
      featuredHotkeys: new Set(["5Hk1"]),
    });
    assert.equal(withFeatured.validators[0].featured, true);

    const notFeatured = buildSubnetValidators([ROW], 7, {
      featuredHotkeys: new Set(["someone-else"]),
    });
    assert.equal(notFeatured.validators[0].featured, false);
  });

  test("coerces a string-typed D1 block_number to an integer in the snapshot stamp + neuron detail", () => {
    // block_number is a nullable D1 INTEGER that can come back as a numeric
    // string; the snapshot stamp (metagraph/validators) and neuron-detail top
    // level must emit an integer or null, never leak the string into the
    // ["integer","null"] contract field. Mirrors the buildGlobalValidators fix
    // (#2611) for the remaining emission sites.
    const meta = buildSubnetMetagraph([{ ...ROW, block_number: "8454388" }], 7);
    assert.equal(meta.block_number, 8454388);
    assert.equal(typeof meta.block_number, "number");
    const vals = buildSubnetValidators(
      [{ ...ROW, block_number: "8454388" }],
      7,
    );
    assert.equal(vals.block_number, 8454388);
    const detail = buildNeuronDetail({ ...ROW, block_number: "8454388" }, 7);
    assert.equal(detail.block_number, 8454388);
    assert.equal(typeof detail.block_number, "number");
    // a null block_number stays null (not a fabricated 0).
    assert.equal(
      buildNeuronDetail({ ...ROW, block_number: null }, 7).block_number,
      null,
    );
  });

  test("coerces a string-typed D1 captured_at to an ISO timestamp in the snapshot stamp + neuron detail", () => {
    // captured_at is a D1 INTEGER (epoch ms) that can come back as a numeric
    // string; the old Number.isFinite(string) guard dropped a real timestamp to
    // null. Coerce it like block_number beside it. Mirrors #2714/#2725.
    const iso = new Date(1750000000000).toISOString();
    const meta = buildSubnetMetagraph(
      [{ ...ROW, captured_at: "1750000000000" }],
      7,
    );
    assert.equal(meta.captured_at, iso);
    const vals = buildSubnetValidators(
      [{ ...ROW, captured_at: "1750000000000" }],
      7,
    );
    assert.equal(vals.captured_at, iso);
    const detail = buildNeuronDetail(
      { ...ROW, captured_at: "1750000000000" },
      7,
    );
    assert.equal(detail.captured_at, iso);
    // null / blank / invalid / out-of-range stay null (never epoch 1970, never
    // a RangeError). 8.64e15 ms is the max valid Date, so 8640000000000001 is
    // finite but new Date(n) is an Invalid Date.
    for (const captured_at of [null, "", "not-a-date", 8640000000000001]) {
      assert.equal(
        buildNeuronDetail({ ...ROW, captured_at }, 7).captured_at,
        null,
        `captured_at=${JSON.stringify(captured_at)}`,
      );
    }
  });

  test("buildGlobalValidators groups validator identities across subnets", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: "100.1234567891",
          emission_tao: 5,
          validator_trust: "0.4",
          block_number: "10",
          captured_at: 1750000000000,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a2",
          stake_tao: 50,
          emission_tao: 9,
          validator_trust: 0.8,
          block_number: 11,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 5,
          uid: 3,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 1,
          emission_tao: 2,
          validator_trust: 0.6,
          block_number: 12,
          captured_at: 1750000001000,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-b",
          coldkey: "ck-b",
          stake_tao: 500,
          emission_tao: 1,
          validator_trust: null,
          block_number: 9,
          captured_at: 1740000000000,
        },
        { ...ROW, netuid: 4, uid: 0, hotkey: null },
      ],
      { sort: "subnet_count", limit: 1 },
    );

    assert.equal(data.sort, "subnet_count");
    assert.equal(data.limit, 1);
    assert.equal(data.validator_count, 2);
    assert.equal(data.validators.length, 1);
    assert.equal(data.captured_at, new Date(1750000001000).toISOString());
    assert.equal(data.block_number, 12);
    const top = data.validators[0];
    assert.equal(top.hotkey, "hk-a");
    assert.equal(top.coldkey, "ck-a");
    assert.equal(top.coldkey_count, 2);
    assert.equal(top.subnet_count, 3);
    assert.equal(top.uid_count, 3);
    assert.equal(top.total_stake_tao, 151.123456789);
    assert.equal(top.root_stake_tao, 0); // no netuid-0 row for hk-a
    assert.equal(top.alpha_stake_tao, 151.123456789);
    assert.equal(top.total_emission_tao, 16);
    assert.equal(top.stake_dominance, 0.232096);
    assert.equal(top.avg_validator_trust, 0.6);
    assert.equal(top.max_validator_trust, 0.8);
    assert.equal(top.latest_captured_at, new Date(1750000001000).toISOString());
    assert.equal(top.latest_block_number, 12);
    assert.deepEqual(
      top.subnets.map((s) => [s.netuid, s.uid]),
      [
        [1, 2],
        [2, 1],
        [5, 3],
      ],
    );
  });

  test("buildGlobalValidators splits root (netuid 0) stake from alpha stake in exact rao space (#2550)", () => {
    const data = buildGlobalValidators([
      {
        ...ROW,
        netuid: 0,
        uid: 1,
        hotkey: "hk-root",
        coldkey: "ck-root",
        stake_tao: 200.5,
        emission_tao: 1,
      },
      {
        ...ROW,
        netuid: 7,
        uid: 2,
        hotkey: "hk-root",
        coldkey: "ck-root",
        stake_tao: 50.25,
        emission_tao: 3,
      },
      {
        ...ROW,
        netuid: 9,
        uid: 4,
        hotkey: "hk-root",
        coldkey: "ck-root",
        stake_tao: 49.25,
        emission_tao: 2,
      },
    ]);
    const entry = data.validators.find((v) => v.hotkey === "hk-root");
    assert.equal(entry.total_stake_tao, 300);
    assert.equal(entry.root_stake_tao, 200.5);
    assert.equal(entry.alpha_stake_tao, 99.5); // 50.25 + 49.25, exact
  });

  test("buildGlobalValidators joins nominator_count by hotkey, nulls a hotkey with no row (#2549)", () => {
    const data = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-known" },
        { ...ROW, netuid: 1, uid: 1, hotkey: "hk-unknown" },
      ],
      { nominatorCounts: new Map([["hk-known", 42]]) },
    );
    const known = data.validators.find((v) => v.hotkey === "hk-known");
    const unknown = data.validators.find((v) => v.hotkey === "hk-unknown");
    assert.equal(known.nominator_count, 42);
    assert.equal(unknown.nominator_count, null);
  });

  test("buildGlobalValidators defaults nominator_count to null on every entry when no map is passed", () => {
    const data = buildGlobalValidators([
      { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a" },
    ]);
    assert.equal(data.validators[0].nominator_count, null);
  });

  test("buildGlobalValidators computes apy_estimate for a single eligible membership (#2551)", () => {
    // tempo=360 -> epochsPerYear = 31,536,000/(360*12) = 7,300 exactly;
    // annualized = 0.85*7,300 = 6,205 TAO/yr; apy = 6,205/1,000 = 6.205.
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 1000,
          emission_tao: 0.85,
        },
      ],
      { tempoByNetuid: new Map([[3, 360]]) },
    );
    const entry = data.validators.find((v) => v.hotkey === "hk-a");
    assert.equal(entry.apy_estimate, 6.205);
    assert.equal(entry.apy_estimate_eligible_subnet_count, 1);
  });

  test("buildGlobalValidators blends apy_estimate stake-weighted across memberships, excluding one with no resolvable tempo (#2551)", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 1000,
          emission_tao: 0.85,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 1,
          hotkey: "hk-a",
          stake_tao: 500,
          emission_tao: 0.1,
        },
        // netuid 21 has no entry in tempoByNetuid -- excluded from both the
        // numerator and denominator, its 200 TAO stake never diluting apy.
        {
          ...ROW,
          netuid: 21,
          uid: 2,
          hotkey: "hk-a",
          stake_tao: 200,
          emission_tao: 5,
        },
      ],
      {
        tempoByNetuid: new Map([
          [3, 360],
          [8, 100],
        ]),
      },
    );
    const entry = data.validators.find((v) => v.hotkey === "hk-a");
    // numerator = 0.85*7,300 + 0.10*26,280 = 6,205 + 2,628 = 8,833
    // denominator = 1,000 + 500 = 1,500 (netuid 21's 200 excluded)
    assert.equal(entry.apy_estimate, Math.round((8833 / 1500) * 1e9) / 1e9);
    assert.equal(entry.apy_estimate_eligible_subnet_count, 2);
    assert.equal(entry.subnet_count, 3); // all 3 memberships still counted
  });

  test("buildGlobalValidators excludes a membership with non-positive stake from apy_estimate even when tempo is known (#2551)", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 0,
          emission_tao: 1,
        },
      ],
      { tempoByNetuid: new Map([[3, 360]]) },
    );
    const entry = data.validators.find((v) => v.hotkey === "hk-a");
    assert.equal(entry.apy_estimate, null);
    assert.equal(entry.apy_estimate_eligible_subnet_count, 0);
  });

  test("buildGlobalValidators nulls apy_estimate AND reports 0 eligible when the only eligible stake rounds to exactly 0 rao (#2551)", () => {
    // 4e-10 TAO is > 0 in JS float terms, so accumulateApyRow's stake > 0
    // guard passes and its own local apyEligibleCount reaches 1 -- but
    // toRaoBig(4e-10) rounds to 0n (sub-rao precision), leaving
    // apyDenominatorRao at 0n. finalizeApy's apyDenominatorRao <= 0n guard
    // catches exactly this: it must report eligible_count 0 (not the raw 1
    // accumulateApyRow counted), never 1, to preserve the field's own
    // documented invariant ("apy_estimate is null iff eligible_count is 0")
    // and avoid a 0/0 division producing NaN instead of a clean null.
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 4e-10,
          emission_tao: 1,
        },
      ],
      { tempoByNetuid: new Map([[3, 360]]) },
    );
    const entry = data.validators.find((v) => v.hotkey === "hk-a");
    assert.equal(entry.apy_estimate, null);
    assert.equal(entry.apy_estimate_eligible_subnet_count, 0);
  });

  test("buildGlobalValidators defaults apy_estimate to null on every entry when no tempoByNetuid map is passed", () => {
    const data = buildGlobalValidators([
      { ...ROW, netuid: 3, uid: 0, hotkey: "hk-a" },
    ]);
    assert.equal(data.validators[0].apy_estimate, null);
    assert.equal(data.validators[0].apy_estimate_eligible_subnet_count, 0);
  });

  test("buildGlobalValidators counts apy-eligible subnets beyond the top-10 subnets[] cap, not leaking the cap into apy_estimate (#2551)", () => {
    // 15 memberships, every one eligible (known tempo, positive stake) --
    // subnets[] on the returned entry is capped to GLOBAL_VALIDATOR_SUBNET_LIMIT
    // (10), but apy_estimate_eligible_subnet_count must reflect all 15: the
    // apy accumulation happens in the row loop, before that cap is applied.
    const tempoByNetuid = new Map();
    const rows = [];
    for (let netuid = 0; netuid < 15; netuid += 1) {
      tempoByNetuid.set(netuid, 360);
      rows.push({
        ...ROW,
        netuid,
        uid: netuid,
        hotkey: "hk-a",
        stake_tao: 100 + netuid, // distinct stakes so the top-10 sort is deterministic
        emission_tao: 1,
      });
    }
    const data = buildGlobalValidators(rows, { tempoByNetuid });
    const entry = data.validators.find((v) => v.hotkey === "hk-a");
    assert.equal(entry.subnets.length, 10);
    assert.equal(entry.apy_estimate_eligible_subnet_count, 15);
    assert.ok(entry.apy_estimate > 0);
  });

  test("buildGlobalValidators takes the first non-null take per hotkey and ignores later rows (#2548)", () => {
    const data = buildGlobalValidators([
      { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", take: 0.18 },
      // A later row for the same hotkey with a different (or missing) take
      // must not override the first value seen -- take is a single
      // per-hotkey chain fact, not something to re-derive per subnet row.
      { ...ROW, netuid: 2, uid: 0, hotkey: "hk-a", take: 0.25 },
      { ...ROW, netuid: 3, uid: 0, hotkey: "hk-b" },
    ]);
    const byHotkey = Object.fromEntries(
      data.validators.map((v) => [v.hotkey, v.take]),
    );
    assert.equal(byHotkey["hk-a"], 0.18);
    assert.equal(byHotkey["hk-b"], null);
  });

  test("buildGlobalValidators sets `featured` per hotkey entry, defaulting false", () => {
    const data = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a" },
        { ...ROW, netuid: 2, uid: 0, hotkey: "hk-a" },
        { ...ROW, netuid: 3, uid: 0, hotkey: "hk-b" },
      ],
      { featuredHotkeys: new Set(["hk-a"]) },
    );
    const byHotkey = Object.fromEntries(
      data.validators.map((v) => [v.hotkey, v.featured]),
    );
    assert.equal(byHotkey["hk-a"], true);
    assert.equal(byHotkey["hk-b"], false);

    // No featuredHotkeys option at all -> every entry still carries a real
    // boolean (false), never an omitted/undefined field.
    const noOption = buildGlobalValidators([
      { ...ROW, netuid: 1, hotkey: "hk-c" },
    ]);
    assert.equal(noOption.validators[0].featured, false);
  });

  test("buildGlobalValidators is cold-safe and normalizes direct-call options", () => {
    const empty = buildGlobalValidators(null, {
      sort: "bogus",
      limit: "bogus",
    });
    assert.equal(empty.sort, "subnet_count");
    assert.equal(empty.limit, 20);
    assert.equal(empty.validator_count, 0);
    assert.deepEqual(empty.validators, []);

    // An explicit limit of 0 yields an EMPTY leaderboard (not a bumped-up single
    // row), matching the chain-turnover / chain-stake-flow / chain-weights (#2984)
    // floor-at-0 convention. validator_count still reports the full set.
    const clamped = buildGlobalValidators(
      [{ ...ROW, netuid: 7, uid: 0, hotkey: "hk-a" }],
      { limit: 0 },
    );
    assert.equal(clamped.limit, 0);
    assert.equal(clamped.validator_count, 1);
    assert.equal(clamped.validators.length, 0);
  });

  test("buildGlobalValidators handles sparse identity rows and trust sorting", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 0,
          hotkey: "hk-low",
          coldkey: "",
          validator_trust: "not-a-number",
          stake_tao: -5,
          emission_tao: -1,
          block_number: 1,
          captured_at: "not-a-date",
        },
        {
          ...ROW,
          netuid: 2,
          uid: 0,
          hotkey: "hk-high",
          coldkey: "ck-high",
          validator_trust: 0.95,
          stake_tao: 10,
          emission_tao: 1,
          block_number: 2,
          captured_at: 1750000002000,
        },
      ],
      { sort: "avg_validator_trust", limit: 10 },
    );

    assert.equal(data.sort, "avg_validator_trust");
    assert.equal(data.captured_at, new Date(1750000002000).toISOString());
    assert.equal(data.block_number, 2);
    assert.equal(data.validators[0].hotkey, "hk-high");
    assert.equal(data.validators[0].avg_validator_trust, 0.95);
    assert.equal(data.validators[1].hotkey, "hk-low");
    assert.equal(data.validators[1].coldkey, null);
    assert.equal(data.validators[1].coldkey_count, 0);
    assert.equal(data.validators[1].avg_validator_trust, null);
    assert.equal(data.validators[1].max_validator_trust, null);
    assert.deepEqual(data.validators[1].subnets[0], {
      netuid: 1,
      uid: 0,
      stake_tao: 0,
      emission_tao: 0,
      validator_trust: null,
    });
  });

  test("buildGlobalValidators uses deterministic footprint tie-breakers", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 9,
          uid: 9,
          hotkey: "hk-z",
          coldkey: "ck-b",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 4,
          hotkey: "hk-z",
          coldkey: "ck-a",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 5,
          hotkey: "hk-z",
          coldkey: "ck-a",
          stake_tao: 5,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 7,
          hotkey: "hk-z",
          coldkey: "ck-c",
          stake_tao: 5,
          emission_tao: 2,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 0,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 1,
          emission_tao: 1,
        },
      ],
      { sort: "subnet_count", limit: 10 },
    );

    assert.deepEqual(
      data.validators.map((validator) => validator.hotkey),
      ["hk-z", "hk-a"],
    );
    assert.equal(data.validators[0].coldkey, "ck-a");
    assert.deepEqual(
      data.validators[0].subnets.map((subnet) => [subnet.netuid, subnet.uid]),
      [
        [3, 7],
        [8, 4],
        [8, 5],
        [9, 9],
      ],
    );

    const alphabetical = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-b" },
        { ...ROW, netuid: 2, uid: 0, hotkey: "hk-a" },
      ],
      { sort: "uid_count", limit: 10 },
    );
    assert.deepEqual(
      alphabetical.validators.map((validator) => validator.hotkey),
      ["hk-a", "hk-b"],
    );
  });

  test("buildValidatorDetail aggregates one hotkey's validator rows across every subnet", () => {
    const data = buildValidatorDetail(
      [
        {
          netuid: 1,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 100.1234567891,
          emission_tao: 5,
          validator_trust: 0.4,
          captured_at: 1750000000000,
          block_number: 10,
        },
        {
          netuid: 2,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 50,
          emission_tao: 9,
          validator_trust: 0.8,
          captured_at: 1750000001000, // later than the first row: updates latest
          block_number: 11,
        },
        {
          netuid: 1,
          uid: 5, // same netuid as the first row, higher uid: exercises the sort's uid tie-break
          hotkey: "hk-a",
          coldkey: "", // empty string: must NOT count as a coldkey
          stake_tao: 1,
          emission_tao: 2,
          validator_trust: null, // must not affect avg/max trust
          captured_at: 1750000001000, // ties the current latest...
          block_number: 15, // ...but wins the tie on a higher block_number
        },
        {
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          coldkey: undefined, // missing coldkey: must not count either
          stake_tao: 500,
          emission_tao: 1,
          validator_trust: 0.6,
          captured_at: 1750000001000, // ties again...
          block_number: 10, // ...but LOSES the tie (lower block_number): no update
        },
        {
          netuid: 6,
          uid: 0,
          hotkey: "hk-a",
          coldkey: "ck-new",
          stake_tao: 2,
          emission_tao: 2,
          validator_trust: null,
          captured_at: null, // must still count toward totals/subnets, just not "latest"
          block_number: 999,
        },
        {
          // No netuid at all: must be skipped entirely, proven by the totals below
          // being unaffected by this row's otherwise-huge stake/emission.
          uid: 0,
          hotkey: "hk-a",
          coldkey: "ck-ignored",
          stake_tao: 99999,
          emission_tao: 99999,
        },
      ],
      "hk-a",
    );

    assert.equal(data.hotkey, "hk-a");
    assert.equal(data.coldkey, "ck-a"); // 2 rows vs. ck-new's 1
    assert.equal(data.coldkey_count, 2);
    assert.equal(data.subnet_count, 5);
    assert.equal(data.total_stake_tao, 653.123456789);
    assert.equal(data.root_stake_tao, 0); // no netuid-0 row for hk-a
    assert.equal(data.alpha_stake_tao, 653.123456789);
    assert.equal(data.total_emission_tao, 19);
    assert.equal(data.avg_validator_trust, 0.6); // (0.4 + 0.8 + 0.6) / 3
    assert.equal(data.max_validator_trust, 0.8);
    assert.equal(data.captured_at, new Date(1750000001000).toISOString());
    assert.equal(data.block_number, 15);
    assert.deepEqual(
      data.subnets.map((s) => [s.netuid, s.uid]),
      [
        [1, 2],
        [1, 5],
        [2, 1],
        [3, 0],
        [6, 0],
      ],
    );
  });

  test("buildValidatorDetail splits root (netuid 0) stake from alpha stake in exact rao space (#2550)", () => {
    const data = buildValidatorDetail(
      [
        {
          netuid: 0,
          uid: 1,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 200.5,
          emission_tao: 1,
        },
        {
          netuid: 7,
          uid: 2,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 50.25,
          emission_tao: 3,
        },
        {
          netuid: 9,
          uid: 4,
          hotkey: "hk-a",
          coldkey: "ck-a",
          stake_tao: 49.25,
          emission_tao: 2,
        },
      ],
      "hk-a",
    );
    assert.equal(data.total_stake_tao, 300);
    assert.equal(data.root_stake_tao, 200.5);
    assert.equal(data.alpha_stake_tao, 99.5); // 50.25 + 49.25, exact
  });

  test("buildValidatorDetail passes through the given nominatorCount option (#2549)", () => {
    const withCount = buildValidatorDetail(
      [{ ...ROW, netuid: 1, uid: 0, hotkey: "hk-a" }],
      "hk-a",
      { nominatorCount: 17 },
    );
    assert.equal(withCount.nominator_count, 17);

    const withoutCount = buildValidatorDetail(
      [{ ...ROW, netuid: 1, uid: 0, hotkey: "hk-a" }],
      "hk-a",
    );
    assert.equal(withoutCount.nominator_count, null);
  });

  test("buildValidatorDetail blends apy_estimate stake-weighted across memberships, excluding one with no resolvable tempo (#2551)", () => {
    const data = buildValidatorDetail(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 1000,
          emission_tao: 0.85,
        },
        {
          ...ROW,
          netuid: 8,
          uid: 1,
          hotkey: "hk-a",
          stake_tao: 500,
          emission_tao: 0.1,
        },
        {
          ...ROW,
          netuid: 21,
          uid: 2,
          hotkey: "hk-a",
          stake_tao: 200,
          emission_tao: 5,
        },
      ],
      "hk-a",
      {
        tempoByNetuid: new Map([
          [3, 360],
          [8, 100],
        ]),
      },
    );
    assert.equal(data.apy_estimate, Math.round((8833 / 1500) * 1e9) / 1e9);
    assert.equal(data.apy_estimate_eligible_subnet_count, 2);
    assert.equal(data.subnet_count, 3);
  });

  test("buildValidatorDetail excludes a non-positive-stake membership from apy_estimate even when tempo is known (#2551)", () => {
    const data = buildValidatorDetail(
      [
        {
          ...ROW,
          netuid: 3,
          uid: 0,
          hotkey: "hk-a",
          stake_tao: 0,
          emission_tao: 1,
        },
      ],
      "hk-a",
      { tempoByNetuid: new Map([[3, 360]]) },
    );
    assert.equal(data.apy_estimate, null);
    assert.equal(data.apy_estimate_eligible_subnet_count, 0);
  });

  test("buildValidatorDetail defaults apy_estimate to null when no tempoByNetuid map is passed", () => {
    const data = buildValidatorDetail(
      [{ ...ROW, netuid: 3, uid: 0, hotkey: "hk-a" }],
      "hk-a",
    );
    assert.equal(data.apy_estimate, null);
    assert.equal(data.apy_estimate_eligible_subnet_count, 0);
  });

  test("buildValidatorDetail's apy_estimate is never capped -- its subnets[] is already uncapped, unlike the leaderboard's top-10 (#2551)", () => {
    const tempoByNetuid = new Map();
    const rows = [];
    for (let netuid = 0; netuid < 15; netuid += 1) {
      tempoByNetuid.set(netuid, 360);
      rows.push({
        ...ROW,
        netuid,
        uid: netuid,
        hotkey: "hk-a",
        stake_tao: 100 + netuid,
        emission_tao: 1,
      });
    }
    const data = buildValidatorDetail(rows, "hk-a", { tempoByNetuid });
    assert.equal(data.subnets.length, 15);
    assert.equal(data.apy_estimate_eligible_subnet_count, 15);
    assert.ok(data.apy_estimate > 0);
  });

  test("buildValidatorDetail: a null latest block_number is beaten by a real one on a captured_at tie, and a null incoming block_number never wins one", () => {
    const data = buildValidatorDetail(
      [
        {
          netuid: 1,
          uid: 0,
          hotkey: "hk-b",
          captured_at: 1000,
          block_number: null,
        },
        {
          netuid: 2,
          uid: 0,
          hotkey: "hk-b",
          captured_at: 1000,
          block_number: 5,
        },
        {
          netuid: 3,
          uid: 0,
          hotkey: "hk-b",
          captured_at: 1000,
          block_number: null,
        },
      ],
      "hk-b",
    );
    assert.equal(data.captured_at, new Date(1000).toISOString());
    assert.equal(data.block_number, 5);
  });

  test("buildValidatorDetail is cold-safe for non-array/empty input", () => {
    const empty = buildValidatorDetail(null, "hk-cold");
    assert.equal(empty.hotkey, "hk-cold");
    assert.equal(empty.coldkey, null);
    assert.equal(empty.coldkey_identity, null);
    assert.equal(empty.coldkey_count, 0);
    assert.equal(empty.subnet_count, 0);
    assert.equal(empty.total_stake_tao, 0);
    assert.equal(empty.root_stake_tao, 0);
    assert.equal(empty.alpha_stake_tao, 0);
    assert.equal(empty.total_emission_tao, 0);
    assert.equal(empty.nominator_count, null);
    assert.equal(empty.avg_validator_trust, null);
    assert.equal(empty.max_validator_trust, null);
    assert.equal(empty.captured_at, null);
    assert.equal(empty.block_number, null);
    assert.deepEqual(empty.subnets, []);
    assert.equal(empty.take, null);
  });

  test("buildValidatorDetail takes the first non-null take across subnet rows (#2548)", () => {
    const data = buildValidatorDetail(
      [
        { ...ROW, netuid: 1, uid: 0, take: 0.18 },
        // Same hotkey, later row -- must not override the first value seen.
        { ...ROW, netuid: 2, uid: 0, take: 0.3 },
      ],
      "hk-a",
    );
    assert.equal(data.take, 0.18);
  });

  test("buildGlobalValidators reports a null block_number as null, not a fabricated 0", () => {
    // block_number is a nullable INTEGER column and the /validators query does not
    // filter it, so a validator's newest capture can carry block_number: null.
    // Number(null) === 0 must NOT surface as the real chain height 0 (block 0 is
    // the genesis block, a height the neuron was never captured at).
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 0,
          hotkey: "hk-null-block",
          block_number: null,
          captured_at: 2000,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-null-block",
          block_number: 99,
          captured_at: 1000,
        },
      ],
      { sort: "subnet_count", limit: 10 },
    );
    // Newest capture (captured_at 2000) has no block height → both the per-validator
    // and top-level block numbers must be null.
    assert.equal(data.block_number, null);
    assert.equal(data.validators[0].latest_block_number, null);
  });

  test("buildGlobalValidators rolls up stake/emission totals and stake dominance", () => {
    const data = buildGlobalValidators(
      [
        {
          ...ROW,
          netuid: 1,
          uid: 0,
          hotkey: "hk-heavy",
          stake_tao: 75,
          emission_tao: 3,
        },
        {
          ...ROW,
          netuid: 2,
          uid: 1,
          hotkey: "hk-heavy",
          stake_tao: 25,
          emission_tao: 1,
        },
        {
          ...ROW,
          netuid: 3,
          uid: 2,
          hotkey: "hk-light",
          stake_tao: 0,
          emission_tao: 0,
        },
        {
          ...ROW,
          netuid: 4,
          uid: 3,
          hotkey: "hk-bad",
          stake_tao: "not-a-number",
          emission_tao: null,
        },
      ],
      { sort: "total_stake", limit: 10 },
    );

    const heavy = data.validators.find((v) => v.hotkey === "hk-heavy");
    const light = data.validators.find((v) => v.hotkey === "hk-light");
    const bad = data.validators.find((v) => v.hotkey === "hk-bad");
    assert.equal(heavy.total_stake_tao, 100);
    assert.equal(heavy.total_emission_tao, 4);
    assert.equal(heavy.stake_dominance, 1);
    assert.equal(light.total_stake_tao, 0);
    assert.equal(light.stake_dominance, 0);
    assert.equal(bad.total_stake_tao, 0);
    assert.deepEqual(
      data.validators.map((v) => v.hotkey),
      ["hk-heavy", "hk-bad", "hk-light"],
    );
  });

  test("buildGlobalValidators nulls stake dominance when network stake is zero", () => {
    const data = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", stake_tao: 0 },
        { ...ROW, netuid: 2, uid: 1, hotkey: "hk-b", stake_tao: 0 },
      ],
      { sort: "subnet_count", limit: 10 },
    );
    assert.equal(
      data.validators.every((v) => v.stake_dominance === null),
      true,
    );
  });

  test("buildGlobalValidators sorts by total_stake with hotkey tie-break", () => {
    const data = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-b", stake_tao: 50 },
        { ...ROW, netuid: 2, uid: 1, hotkey: "hk-a", stake_tao: 50 },
      ],
      { sort: "total_stake", limit: 10 },
    );
    assert.deepEqual(
      data.validators.map((v) => v.hotkey),
      ["hk-a", "hk-b"],
    );
  });

  test("sums a hotkey's per-UID stake in exact rao space, not compounding float error (#2922)", () => {
    // One hotkey validating on thousands of subnets, each contributing a real
    // sub-TAO fractional stake -- plain `+=` float accumulation across many
    // rows would drift from the true sum. Summing in rao BigInt space must not.
    const rows = [];
    let expectedTotalRao = 0n;
    for (let i = 0; i < 5000; i += 1) {
      const stakeTao = 1234.987654321 + i * 0.000000001;
      rows.push({
        ...ROW,
        netuid: i,
        uid: 0,
        hotkey: "hk-precision",
        stake_tao: stakeTao,
        emission_tao: 0,
      });
      expectedTotalRao += BigInt(Math.round(stakeTao * 1e9));
    }
    const data = buildGlobalValidators(rows, {
      sort: "total_stake",
      limit: 10,
    });
    const expectedTotal =
      Number(expectedTotalRao / 1_000_000_000n) +
      Number(expectedTotalRao % 1_000_000_000n) / 1e9;
    const entry = data.validators.find((v) => v.hotkey === "hk-precision");
    assert.equal(entry.total_stake_tao, Math.round(expectedTotal * 1e9) / 1e9);
  });

  test("builders drop malformed rows and count only real neurons", () => {
    // A null/non-object row can't be a Neuron, so it must not leak into the
    // array — and the count tracks the array (neuron_count === neurons.length),
    // matching the blocks/extrinsics feed builders' .filter(Boolean).
    const data = buildSubnetMetagraph([ROW, null, MINER, undefined], 7);
    assert.equal(data.neurons.length, 2);
    assert.ok(data.neurons.every(Boolean));
    const vals = buildSubnetValidators([ROW, null], 7);
    assert.equal(vals.validators.length, 1);
    assert.equal(vals.validator_count, 1);
  });

  test("buildNeuronDetail returns neuron:null for a cold/absent row", () => {
    assert.equal(buildNeuronDetail(null, 7).neuron, null);
    assert.equal(buildNeuronDetail(ROW, 7).neuron.uid, 0);
  });

  // #5234: server-side coldkey -> account_identity join, exposed as
  // coldkey_identity on both GlobalValidatorEntry and ValidatorDetailArtifact.
  const IDENTITY_ROW = {
    name: "Acme Validators",
    url: "https://acme-validators.io",
    github: "https://github.com/acme-validators",
    image: "https://acme-validators.io/logo.png",
    discord: "acme#1234",
    description: "Professional validator operator",
    additional: "Est. 2023",
    captured_at: 1750000000000,
  };

  test("buildGlobalValidators joins coldkey_identity by coldkey, not hotkey -- shared across two hotkeys (#5234)", () => {
    const identityByColdkey = new Map([["ck-shared", IDENTITY_ROW]]);
    const data = buildGlobalValidators(
      [
        { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", coldkey: "ck-shared" },
        { ...ROW, netuid: 2, uid: 0, hotkey: "hk-b", coldkey: "ck-shared" },
      ],
      { identityByColdkey },
    );
    const byHotkey = Object.fromEntries(
      data.validators.map((v) => [v.hotkey, v.coldkey_identity]),
    );
    for (const hotkey of ["hk-a", "hk-b"]) {
      assert.equal(byHotkey[hotkey].has_identity, true);
      assert.equal(byHotkey[hotkey].name, "Acme Validators");
      assert.equal(byHotkey[hotkey].url, "https://acme-validators.io/");
      assert.equal(byHotkey[hotkey].discord, "acme#1234");
      assert.equal(
        byHotkey[hotkey].captured_at,
        new Date(1750000000000).toISOString(),
      );
      // schema_version/account are AccountIdentityArtifact-only -- redundant
      // once nested under a row that already states its own coldkey.
      assert.equal(byHotkey[hotkey].schema_version, undefined);
      assert.equal(byHotkey[hotkey].account, undefined);
    }
  });

  test("buildGlobalValidators reports a has_identity:false shape (never omitted) when the coldkey has no identity row (#5234)", () => {
    const data = buildGlobalValidators([
      { ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", coldkey: "ck-no-identity" },
    ]);
    const identity = data.validators[0].coldkey_identity;
    assert.equal(identity.has_identity, false);
    assert.equal(identity.name, null);
    assert.equal(identity.url, null);
    assert.equal(identity.github, null);
    assert.equal(identity.image, null);
    assert.equal(identity.discord, null);
    assert.equal(identity.description, null);
    assert.equal(identity.additional, null);
    assert.equal(identity.captured_at, null);
  });

  test("buildGlobalValidators sets coldkey_identity null only when coldkey itself is null (#5234)", () => {
    const identityByColdkey = new Map([["ck-shared", IDENTITY_ROW]]);
    const data = buildGlobalValidators(
      [{ ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", coldkey: "" }],
      { identityByColdkey },
    );
    assert.equal(data.validators[0].coldkey, null);
    assert.equal(data.validators[0].coldkey_identity, null);
  });

  test("buildValidatorDetail joins coldkey_identity for its primary coldkey (#5234)", () => {
    const identityByColdkey = new Map([["ck-a", IDENTITY_ROW]]);
    const data = buildValidatorDetail(
      [{ ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", coldkey: "ck-a" }],
      "hk-a",
      { identityByColdkey },
    );
    assert.equal(data.coldkey, "ck-a");
    assert.equal(data.coldkey_identity.has_identity, true);
    assert.equal(data.coldkey_identity.name, "Acme Validators");
    assert.equal(
      data.coldkey_identity.description,
      "Professional validator operator",
    );
  });

  test("buildValidatorDetail reports has_identity:false when identityByColdkey has no row for the coldkey (#5234)", () => {
    const data = buildValidatorDetail(
      [{ ...ROW, netuid: 1, uid: 0, hotkey: "hk-a", coldkey: "ck-a" }],
      "hk-a",
      { identityByColdkey: new Map([["ck-other", IDENTITY_ROW]]) },
    );
    assert.equal(data.coldkey, "ck-a");
    assert.equal(data.coldkey_identity.has_identity, false);
    assert.equal(data.coldkey_identity.name, null);
  });
});

describe("overlayFeaturedValidators (#5166)", () => {
  test("moves featured rows to the front on the default (unsorted) view", () => {
    const data = {
      schema_version: 1,
      sort: "subnet_count",
      limit: 20,
      validator_count: 3,
      validators: [
        { hotkey: "hk-a", featured: false },
        { hotkey: "hk-b", featured: true },
        { hotkey: "hk-c", featured: false },
      ],
    };
    const out = overlayFeaturedValidators(data);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["hk-b", "hk-a", "hk-c"],
    );
  });

  test("preserves relative order within the featured and non-featured groups (stable partition, not a re-sort)", () => {
    const data = {
      sort: "subnet_count",
      validators: [
        { hotkey: "hk-a", featured: true },
        { hotkey: "hk-b", featured: false },
        { hotkey: "hk-c", featured: true },
        { hotkey: "hk-d", featured: false },
      ],
    };
    const out = overlayFeaturedValidators(data);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["hk-a", "hk-c", "hk-b", "hk-d"],
    );
  });

  test("does NOT reorder when an explicit, non-default sort is requested -- featured stays present", () => {
    const data = {
      sort: "total_stake",
      validators: [
        { hotkey: "hk-a", featured: false },
        { hotkey: "hk-b", featured: true },
      ],
    };
    const out = overlayFeaturedValidators(data);
    // Order is untouched (the caller's explicit ranking is honored)...
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["hk-a", "hk-b"],
    );
    // ...but the flag itself is still on every row, so the frontend can still
    // render the badge.
    assert.equal(out.validators[0].featured, false);
    assert.equal(out.validators[1].featured, true);
  });

  test("always reorders a SubnetValidatorsArtifact (no `sort` field at all)", () => {
    const data = {
      schema_version: 1,
      netuid: 7,
      validator_count: 2,
      validators: [
        { hotkey: "hk-a", featured: false },
        { hotkey: "hk-b", featured: true },
      ],
    };
    const out = overlayFeaturedValidators(data);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["hk-b", "hk-a"],
    );
  });

  test("is a no-op when nothing is featured", () => {
    const data = {
      sort: "subnet_count",
      validators: [
        { hotkey: "hk-a", featured: false },
        { hotkey: "hk-b", featured: false },
      ],
    };
    const out = overlayFeaturedValidators(data);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["hk-a", "hk-b"],
    );
  });

  test("is null-safe / shape-safe (cold payloads, missing validators array)", () => {
    assert.equal(overlayFeaturedValidators(null), null);
    assert.equal(overlayFeaturedValidators(undefined), undefined);
    const noValidators = { sort: "subnet_count" };
    assert.equal(overlayFeaturedValidators(noValidators), noValidators);
    const empty = { sort: "subnet_count", validators: [] };
    assert.deepEqual(overlayFeaturedValidators(empty).validators, []);
  });
});

describe("metagraph-neurons loaders", () => {
  // A d1 runner that filters by validator_permit and APPLIES the SQL's ORDER BY
  // (parsing the real clause), so a missing tie-break would actually reorder the
  // result — not a circular check that passes regardless.
  function orderingD1(rows) {
    return async (sql) => {
      let r = rows.filter((x) => x.validator_permit === 1);
      const order = /ORDER BY (.+?)(?:$|\bLIMIT\b)/.exec(sql);
      if (order) {
        const keys = order[1]
          .split(",")
          .map((part) => part.trim().split(/\s+/));
        r = [...r].sort((a, b) => {
          for (const [col, dir] of keys) {
            const delta = (a[col] - b[col]) * (dir === "DESC" ? -1 : 1);
            if (delta !== 0) return delta;
          }
          return 0;
        });
      }
      return r;
    };
  }

  test("loadSubnetValidators ranks by stake, breaking equal-stake ties by uid", async () => {
    const d1 = orderingD1([
      { uid: 9, validator_permit: 1, stake_tao: 100 },
      { uid: 2, validator_permit: 1, stake_tao: 100 }, // tie with uid 9
      { uid: 5, validator_permit: 1, stake_tao: 250 },
      { uid: 4, validator_permit: 0, stake_tao: 999 }, // not a validator
    ]);
    const data = await loadSubnetValidators(d1, 7);
    // 250 first; the two 100-stake validators tie → uid ascending (2 before 9).
    assert.deepEqual(
      data.validators.map((v) => v.uid),
      [5, 2, 9],
    );
    assert.equal(data.validator_count, 3); // the miner is excluded
  });

  test("loadGlobalValidators reads validator rows and applies requested ranking", async () => {
    let seenSql = "";
    let seenParams = null;
    const data = await loadGlobalValidators(
      async (sql, params) => {
        seenSql = sql;
        seenParams = params;
        return [
          {
            netuid: 1,
            uid: 0,
            hotkey: "hk-a",
            coldkey: "ck-a",
            stake_tao: 10,
            emission_tao: 7,
            validator_trust: 0.7,
          },
          {
            netuid: 2,
            uid: 0,
            hotkey: "hk-b",
            coldkey: "ck-b",
            stake_tao: 100,
            emission_tao: 1,
            validator_trust: 0.5,
          },
        ];
      },
      { sort: "avg_validator_trust", limit: 1 },
    );
    assert.match(seenSql, /validator_permit = 1 AND hotkey IS NOT NULL/);
    assert.match(seenSql, /ORDER BY hotkey ASC/);
    assert.deepEqual(seenParams, []);
    assert.equal(data.validators.length, 1);
    assert.equal(data.validators[0].hotkey, "hk-a");
  });

  test("loadValidatorDetail queries by hotkey + validator_permit, ordered by netuid/uid", async () => {
    let seenSql = "";
    let seenParams = null;
    const data = await loadValidatorDetail(async (sql, params) => {
      seenSql = sql;
      seenParams = params;
      return [
        { netuid: 2, uid: 0, hotkey: "hk-a", coldkey: "ck-a", stake_tao: 10 },
        { netuid: 1, uid: 3, hotkey: "hk-a", coldkey: "ck-a", stake_tao: 20 },
      ];
    }, "hk-a");
    assert.match(seenSql, /hotkey = \? AND validator_permit = 1/);
    assert.match(seenSql, /ORDER BY netuid ASC, uid ASC/);
    assert.deepEqual(seenParams, ["hk-a"]);
    assert.equal(data.hotkey, "hk-a");
    assert.equal(data.subnet_count, 2);
  });
});

// D1 mock honoring the handlers' WHERE clauses.
function neuronsD1(rows) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            all() {
              let r = rows;
              if (sql.includes("validator_permit = 1")) {
                r = r.filter((x) => x.validator_permit === 1);
              }
              if (sql.includes("AND uid = ?")) {
                r = r.filter((x) => x.uid === params[1]);
              }
              if (sql.includes("hotkey = ?")) {
                r = r.filter((x) => x.hotkey === params[0]);
              }
              return Promise.resolve({ results: r });
            },
          };
        },
      };
    },
  };
}

const getJson = async (path, env) => {
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    env,
    {},
  );
  return { res, body: await res.json() };
};

const getText = async (path, env, init = {}) => {
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh${path}`, init),
    env,
    {},
  );
  return { res, text: await res.text() };
};

function createMoversEnv({ comparable = true } = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all() {
                if (/MIN\(snapshot_date\)/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      comparable
                        ? { start_date: "2026-05-31", end_date: "2026-06-30" }
                        : {
                            start_date: "2026-06-30",
                            end_date: "2026-06-30",
                          },
                    ],
                  });
                }
                if (/GROUP BY netuid, snapshot_date/.test(sql)) {
                  return Promise.resolve({
                    results: [
                      {
                        netuid: 1,
                        snapshot_date: "2026-05-31",
                        neuron_count: 10,
                        validator_count: 3,
                        total_stake_tao: 100,
                        total_emission_tao: 5,
                      },
                      {
                        netuid: 1,
                        snapshot_date: "2026-06-30",
                        neuron_count: 12,
                        validator_count: 4,
                        total_stake_tao: 250,
                        total_emission_tao: 9,
                      },
                      {
                        netuid: 2,
                        snapshot_date: "2026-05-31",
                        neuron_count: 8,
                        validator_count: 2,
                        total_stake_tao: 50,
                        total_emission_tao: 4,
                      },
                      {
                        netuid: 2,
                        snapshot_date: "2026-06-30",
                        neuron_count: 8,
                        validator_count: 2,
                        total_stake_tao: 30,
                        total_emission_tao: 4,
                      },
                    ],
                  });
                }
                return Promise.resolve({ results: [] });
              },
            };
          },
        };
      },
    },
  };
}

describe("metagraph routes (#1304/#1305) via the Worker", () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: neuronsD1([ROW, MINER]),
  };

  test("GET /subnets/{n}/metagraph?format=csv emits a header-only cold export", async () => {
    const coldEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: neuronsD1([]),
    };
    const { res, text } = await getText(
      "/api/v1/subnets/7/metagraph?format=csv",
      coldEnv,
    );
    assert.equal(res.status, 200);
    assert.equal(text, NEURON_CSV_HEADER);
  });

  test("GET /subnets/movers?format=csv emits a header-only cold export", async () => {
    const { text } = await getText(
      "/api/v1/subnets/movers?format=csv",
      createMoversEnv({ comparable: false }),
    );
    assert.equal(text, MOVERS_CSV_HEADER);
  });

  test("GET /subnets/movers rejects invalid response formats", async () => {
    const { res } = await getJson("/api/v1/subnets/movers?format=xml", env);
    assert.equal(res.status, 400);
  });

  test("GET /subnets/{n}/validators rejects invalid response formats", async () => {
    const { res } = await getJson(
      "/api/v1/subnets/7/validators?format=xml",
      env,
    );
    assert.equal(res.status, 400);
  });

  test("GET /validators?format=csv emits a header-only cold export", async () => {
    const coldEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: neuronsD1([]),
    };
    const { text } = await getText("/api/v1/validators?format=csv", coldEnv);
    assert.equal(text, GLOBAL_VALIDATOR_CSV_HEADER);
  });

  test("GET /validators rejects invalid query params", async () => {
    const { res } = await getJson("/api/v1/validators?sort=bogus", env);
    assert.equal(res.status, 400);

    const unsupported = await getJson("/api/v1/validators?foo=bar", env);
    assert.equal(unsupported.res.status, 400);

    const badLimit = await getJson("/api/v1/validators?limit=0", env);
    assert.equal(badLimit.res.status, 400);

    const badFormat = await getJson("/api/v1/validators?format=xml", env);
    assert.equal(badFormat.res.status, 400);

    const emptyFormat = await getJson("/api/v1/validators?format=", env);
    assert.equal(emptyFormat.res.status, 400);
  });

  const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  test("GET /validators/{hotkey} for an absent hotkey returns a zeroed aggregate, never 404", async () => {
    const { res, body } = await getJson(`/api/v1/validators/${HOTKEY}`, env);
    assert.equal(res.status, 200);
    assert.equal(body.data.hotkey, HOTKEY);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
  });

  test("GET /subnets/{n}/neurons/{uid} for an absent uid → 200 neuron:null", async () => {
    const { res, body } = await getJson("/api/v1/subnets/7/neurons/999", env);
    assert.equal(res.status, 200);
    assert.equal(body.data.neuron, null);
  });

  test("an unsupported query param → 400", async () => {
    const { res } = await getJson("/api/v1/subnets/7/metagraph?bogus=1", env);
    assert.equal(res.status, 400);

    const badFormat = await getJson(
      "/api/v1/subnets/7/metagraph?format=xml",
      env,
    );
    assert.equal(badFormat.res.status, 400);
  });
});

describe("composeValidatorComparison (#6035)", () => {
  // A minimal buildValidatorDetail-shaped object -- only the fields the
  // comparison projects, plus a subnets[] for the subnet_context path.
  function detail(overrides = {}) {
    return {
      schema_version: 1,
      hotkey: "5Hk-a",
      coldkey: "5Co-a",
      coldkey_identity: { has_identity: false, name: null },
      take: 0.18,
      apy_estimate: 0.2,
      apy_estimate_eligible_subnet_count: 2,
      nominator_count: 42,
      total_stake_tao: 1000,
      total_emission_tao: 5,
      avg_validator_trust: 0.9,
      max_validator_trust: 0.99,
      subnet_count: 2,
      subnets: [
        { netuid: 7, uid: 3, stake_tao: 800, validator_trust: 0.9 },
        { netuid: 12, uid: 4, stake_tao: 200, validator_trust: 0.8 },
      ],
      ...overrides,
    };
  }

  test("projects the decision fields for each validator, preserving order", () => {
    const out = composeValidatorComparison([
      detail({ hotkey: "5Hk-a" }),
      detail({ hotkey: "5Hk-b", take: 0.05, nominator_count: 7 }),
    ]);
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, null);
    assert.equal(out.validator_count, 2);
    assert.deepEqual(
      out.validators.map((v) => v.hotkey),
      ["5Hk-a", "5Hk-b"],
    );
    const first = out.validators[0];
    // Exactly the projected fields -- no subnets[] pass-through, and no
    // transaction/signing field ever appears.
    assert.deepEqual(Object.keys(first).sort(), [
      "apy_estimate",
      "apy_estimate_eligible_subnet_count",
      "avg_validator_trust",
      "coldkey",
      "coldkey_identity",
      "hotkey",
      "max_validator_trust",
      "nominator_count",
      "subnet_context",
      "subnet_count",
      "take",
      "total_emission_tao",
      "total_stake_tao",
    ]);
    assert.equal(first.take, 0.18);
    assert.equal(first.nominator_count, 42);
    assert.deepEqual(first.coldkey_identity, {
      has_identity: false,
      name: null,
    });
    // netuid omitted -> no subnet context on any row.
    assert.equal(first.subnet_context, null);
    assert.equal(out.validators[1].subnet_context, null);
  });

  test("with a netuid, each row carries its membership in that subnet or null", () => {
    const out = composeValidatorComparison(
      [
        detail({ hotkey: "5Hk-a" }),
        // A validator that does not validate on netuid 7.
        detail({
          hotkey: "5Hk-b",
          subnets: [{ netuid: 12, uid: 9, stake_tao: 200 }],
        }),
      ],
      { netuid: 7 },
    );
    assert.equal(out.netuid, 7);
    assert.deepEqual(out.validators[0].subnet_context, {
      netuid: 7,
      uid: 3,
      stake_tao: 800,
      validator_trust: 0.9,
    });
    assert.equal(out.validators[1].subnet_context, null);
  });

  test("missing fields and a missing subnets[] degrade to null, never throw", () => {
    const out = composeValidatorComparison(
      [
        // No coldkey_identity, no take, no subnets -- every gap becomes null.
        { hotkey: "5Hk-c" },
        // A null element must not crash the projection.
        null,
      ],
      { netuid: 7 },
    );
    assert.equal(out.validator_count, 2);
    const sparse = out.validators[0];
    assert.equal(sparse.hotkey, "5Hk-c");
    assert.equal(sparse.take, null);
    assert.equal(sparse.coldkey_identity, null);
    assert.equal(sparse.subnet_context, null);
    const nullRow = out.validators[1];
    assert.equal(nullRow.hotkey, null);
    assert.equal(nullRow.subnet_context, null);
  });

  test("a non-array `details` yields an empty, schema-stable comparison", () => {
    const out = composeValidatorComparison(undefined);
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, null);
    assert.equal(out.validator_count, 0);
    assert.deepEqual(out.validators, []);
  });
});
