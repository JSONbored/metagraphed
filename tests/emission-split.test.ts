// #10928: the recipient split, and the 18% that is not in the rows.
//
// The fixture reproduces SN74 as measured against production on 2026-08-12 —
// validator-permit UIDs took 88.3% of the observed per-UID emission and
// non-validator UIDs 11.7% — so a change that silently alters either leg shows
// up as a number the epic already published.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetEmissionSplitHistory,
  emissionSplitWindowLabel,
  EMISSION_SPLIT_HISTORY_ROW_CAP,
  parseEmissionSplitHistoryWindow,
  SUBNET_EMISSION_SPLIT_FIELD_SOURCES,
} from "../src/emission-split.ts";
import { OWNER_CUT } from "../src/revenue-coverage.ts";
import { SubnetEmissionSplitHistoryArtifactSchema } from "../schemas-src/routes/emission-split.ts";

type Row = Record<string, unknown>;

/** SN74's shape: three validator UIDs holding 88.3% of per-UID emission, five
 * earning miners and one on zero. `alpha_out_emission: 1` is the usual value,
 * so a day totals 7200 alpha. */
function sn74Day(date: string, extra: Row = {}): Row[] {
  const base = {
    snapshot_date: date,
    alpha_out_emission: 1,
    alpha_price_tao: 0.0135,
    ...extra,
  };
  const rows: Row[] = [
    { ...base, validator_permit: true, emission_tao: 92.9875 },
    { ...base, validator_permit: true, emission_tao: 121.3727 },
    { ...base, validator_permit: true, emission_tao: 46.3318 },
  ];
  for (let i = 0; i < 5; i += 1) {
    rows.push({ ...base, validator_permit: false, emission_tao: 34.5096 / 5 });
  }
  rows.push({ ...base, validator_permit: false, emission_tao: 0 });
  return rows;
}

describe("the measured legs reproduce the published SN74 split", () => {
  test("validator and miner shares of observed per-UID emission", () => {
    const out = buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {
      window: "30d",
    });
    const p = out.points as Row[];
    assert.equal(out.point_count, 1);
    // 295.2016 alpha is the per-tempo sum every 360-tempo subnet with
    // alpha_out_emission 1 carries — measured live across 128 subnets.
    assert.ok(Math.abs((p[0].uid_alpha as number) - 295.2016) < 0.001);
    assert.ok(
      Math.abs((p[0].validator_share_of_uid as number) - 0.8831) < 1e-4,
    );
    assert.ok(Math.abs((p[0].miner_share_of_uid as number) - 0.1169) < 1e-4);
  });

  test("counts separate the population from who actually earned", () => {
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    assert.equal(p.validator_count, 3);
    assert.equal(p.miner_count, 6);
    assert.equal(p.earning_validator_count, 3);
    // Five of six. A zero-emission UID is still a registered miner, and
    // dropping it would shrink the denominator and overstate participation.
    assert.equal(p.earning_miner_count, 5);
    assert.equal(p.neuron_count, 9);
  });
});

describe("THE OWNER LEG IS NOT IN THE ROWS", () => {
  test("the three whole-day shares sum to 1", () => {
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    const sum =
      (p.owner_share as number) +
      (p.validator_share as number) +
      (p.miner_share as number);
    assert.ok(
      Math.abs(sum - 1) < 1e-6,
      `shares must account for the whole day, got ${sum}`,
    );
  });

  test("summing only the rows would lose exactly the owner cut", () => {
    // The bug this module exists to avoid: uid_alpha is 82% of the day, not
    // all of it, and a split built from the rows alone would publish shares of
    // 82% while calling them shares of the emission.
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    const total = p.total_alpha as number;
    const uid = p.uid_alpha as number;
    assert.equal(total, 7200);
    // 295.2016 per tempo is not the daily total; the RATIO is what carries.
    assert.ok(
      Math.abs((p.owner_alpha as number) / total - OWNER_CUT) < 1e-9,
      "the owner leg is exactly the protocol cut of the day",
    );
    assert.ok(
      Math.abs(
        (p.validator_share as number) / (p.validator_share_of_uid as number) -
          (1 - OWNER_CUT),
      ) < 1e-6,
      "a whole-day validator share is its per-UID share scaled by the non-owner remainder",
    );
    assert.ok(uid > 0);
  });

  test("owner_cut is 18%, not one sixth", () => {
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    // 11796/65535. The difference from 1/6 is ~6 TAO/day on SN64, and it is
    // imported from revenue-coverage.ts rather than restated so /owner-cut,
    // /revenue and this route cannot disagree.
    assert.ok(Math.abs((p.owner_cut as number) - 0.179995422) < 1e-9);
    assert.notEqual(p.owner_cut, 1 / 6);
  });

  test("a caller may override the cut, and a nonsense one falls back", () => {
    const withZero = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {
        ownerCut: 0,
      }).points as Row[]
    )[0];
    assert.equal(withZero.owner_alpha, 0);
    assert.equal(withZero.owner_share, 0);
    // A subnet with owner_cut_enabled false gives the whole day to the UID set.
    const sum =
      (withZero.owner_share as number) +
      (withZero.validator_share as number) +
      (withZero.miner_share as number);
    assert.ok(Math.abs(sum - 1) < 1e-6);

    for (const bad of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) {
      const p = (
        buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {
          ownerCut: bad,
        }).points as Row[]
      )[0];
      assert.ok(
        Math.abs((p.owner_cut as number) - OWNER_CUT) < 1e-9,
        `an out-of-range cut must fall back, got ${p.owner_cut}`,
      );
    }
  });
});

describe("measured survives when reconstructed cannot be computed", () => {
  test("a day with no alpha_out_emission keeps its exact ratio", () => {
    const rows = sn74Day("2026-08-12").map((r) => ({
      ...r,
      alpha_out_emission: null,
    }));
    const p = (
      buildSubnetEmissionSplitHistory(rows, 74, {}).points as Row[]
    )[0];
    // The whole reconstructed half declines...
    assert.equal(p.total_alpha, null);
    assert.equal(p.owner_alpha, null);
    assert.equal(p.owner_share, null);
    assert.equal(p.validator_share, null);
    assert.equal(p.miner_share, null);
    assert.equal(p.total_tao, null);
    // ...and the measured half is untouched, because it is a real answer.
    assert.ok(Math.abs((p.validator_share_of_uid as number) - 0.8831) < 1e-4);
    assert.ok((p.uid_alpha as number) > 0);
    assert.equal(p.earning_miner_count, 5);
  });

  test("a day that emitted nothing has null ratios, never 0", () => {
    // 0 would read as "validators received none of it", which is a different
    // claim from "there was nothing to receive".
    const rows = sn74Day("2026-08-12").map((r) => ({
      ...r,
      emission_tao: 0,
    }));
    const p = (
      buildSubnetEmissionSplitHistory(rows, 74, {}).points as Row[]
    )[0];
    assert.equal(p.uid_alpha, 0);
    assert.equal(p.validator_share_of_uid, null);
    assert.equal(p.miner_share_of_uid, null);
    assert.equal(p.validator_share, null);
    assert.equal(p.earning_miner_count, 0);
    // The population is still real.
    assert.equal(p.miner_count, 6);
  });

  test("total_tao declines when either input is missing", () => {
    const noPrice = sn74Day("2026-08-12").map((r) => ({
      ...r,
      alpha_price_tao: null,
    }));
    const p = (
      buildSubnetEmissionSplitHistory(noPrice, 74, {}).points as Row[]
    )[0];
    assert.equal(p.alpha_price_tao, null);
    assert.equal(p.total_tao, null);
    assert.equal(p.total_alpha, 7200, "the alpha leg is unaffected");
  });
});

describe("the series", () => {
  test("groups by day, newest first, and reports the depth it found", () => {
    const rows = [
      ...sn74Day("2026-08-12"),
      ...sn74Day("2026-08-11"),
      ...sn74Day("2026-08-10"),
    ];
    const out = buildSubnetEmissionSplitHistory(rows, 74, { window: "30d" });
    assert.equal(out.point_count, 3);
    assert.deepEqual(
      (out.points as Row[]).map((p) => p.snapshot_date),
      ["2026-08-12", "2026-08-11", "2026-08-10"],
    );
    // A 30d window over 3 days of rollup reports 3, not 30.
    assert.equal(out.window, "30d");
  });

  test("a capped read drops the oldest day, which the cap truncated", () => {
    const rows = [...sn74Day("2026-08-12"), ...sn74Day("2026-08-11")];
    const out = buildSubnetEmissionSplitHistory(rows, 74, { capped: true });
    assert.equal(out.point_count, 1);
    assert.equal((out.points as Row[])[0].snapshot_date, "2026-08-12");
  });

  test("a capped read of a single day keeps it rather than emptying", () => {
    const out = buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {
      capped: true,
    });
    assert.equal(out.point_count, 1);
  });

  test("rows with no usable snapshot_date are skipped, not thrown on", () => {
    const rows = [
      { snapshot_date: null, validator_permit: true, emission_tao: 1 },
      { snapshot_date: "", validator_permit: true, emission_tao: 1 },
      ...sn74Day("2026-08-12"),
    ];
    const out = buildSubnetEmissionSplitHistory(rows, 74, {});
    assert.equal(out.point_count, 1);
  });

  test("a cold store is an empty series, never a throw or a 404", () => {
    for (const empty of [null, undefined, []]) {
      const out = buildSubnetEmissionSplitHistory(empty, 74, {
        window: "7d",
      });
      assert.equal(out.point_count, 0);
      assert.deepEqual(out.points, []);
      assert.equal(out.netuid, 74);
      assert.equal(out.window, "7d");
    }
  });

  test("the row cap leaves head room over a full 90d read", () => {
    // 256 UIDs x 90 days ~= 23k.
    assert.ok(EMISSION_SPLIT_HISTORY_ROW_CAP > 256 * 90);
  });
});

describe("boolean and numeric cells from either dialect", () => {
  test("validator_permit is read as true from both Postgres and SQLite", () => {
    // Postgres answers `true`; the SQLite double answers `1`. A misread here
    // flips a UID between the two legs this module exists to separate.
    const rows = [
      {
        snapshot_date: "2026-08-12",
        validator_permit: 1,
        emission_tao: 10,
        alpha_out_emission: 1,
      },
      {
        snapshot_date: "2026-08-12",
        validator_permit: true,
        emission_tao: 10,
        alpha_out_emission: 1,
      },
      {
        snapshot_date: "2026-08-12",
        validator_permit: 0,
        emission_tao: 5,
        alpha_out_emission: 1,
      },
      {
        snapshot_date: "2026-08-12",
        validator_permit: false,
        emission_tao: 5,
        alpha_out_emission: 1,
      },
    ];
    const p = (
      buildSubnetEmissionSplitHistory(rows, 74, {}).points as Row[]
    )[0];
    assert.equal(p.validator_count, 2);
    assert.equal(p.miner_count, 2);
    assert.equal(p.validator_alpha, 20);
    assert.equal(p.miner_alpha, 10);
  });

  test("a negative or non-finite cell is read as absent, not as a value", () => {
    // Number("") is 0 and Number("x") is NaN; a negative emission is not a
    // thing the chain produces. All three must read as "no figure" rather than
    // being summed into a leg.
    const rows = [
      {
        snapshot_date: "2026-08-12",
        validator_permit: false,
        emission_tao: -5,
        alpha_out_emission: -1,
      },
      {
        snapshot_date: "2026-08-12",
        validator_permit: false,
        emission_tao: "not a number",
        alpha_out_emission: -1,
      },
    ];
    const p = (
      buildSubnetEmissionSplitHistory(rows, 74, {}).points as Row[]
    )[0];
    assert.equal(p.miner_alpha, 0);
    assert.equal(p.earning_miner_count, 0);
    assert.equal(p.miner_count, 2, "the UIDs are still registered");
    // A negative alpha_out_emission is likewise not a day total.
    assert.equal(p.total_alpha, null);
  });

  test("a blank emission cell counts the UID but adds nothing", () => {
    // Number("") is 0, and a fabricated zero is a measurement this must not
    // invent — but the UID is still registered and still earned nothing.
    const rows = [
      {
        snapshot_date: "2026-08-12",
        validator_permit: false,
        emission_tao: "",
        alpha_out_emission: 1,
      },
      {
        snapshot_date: "2026-08-12",
        validator_permit: false,
        emission_tao: null,
        alpha_out_emission: 1,
      },
    ];
    const p = (
      buildSubnetEmissionSplitHistory(rows, 74, {}).points as Row[]
    )[0];
    assert.equal(p.miner_count, 2);
    assert.equal(p.earning_miner_count, 0);
    assert.equal(p.miner_alpha, 0);
  });
});

describe("the window vocabulary", () => {
  test("accepts the published set and defaults to 30d", () => {
    assert.deepEqual(parseEmissionSplitHistoryWindow("7d"), {
      label: "7d",
      days: 7,
    });
    assert.deepEqual(parseEmissionSplitHistoryWindow(undefined), {
      label: "30d",
      days: 30,
    });
    assert.deepEqual(parseEmissionSplitHistoryWindow(""), {
      label: "30d",
      days: 30,
    });
  });

  test("the label helper defaults an absent window and passes a set one through", () => {
    // Both arms driven directly. In production `parseArgumentsAtDispatch`
    // fills the GraphQL resolver's argument from the published schema, so the
    // fallback arm is unreachable there -- which is exactly why the guard was
    // pulled out here, where it can be proven rather than ignored.
    assert.equal(emissionSplitWindowLabel("7d"), "7d");
    assert.equal(emissionSplitWindowLabel("90d"), "90d");
    assert.equal(emissionSplitWindowLabel(undefined), "30d");
    assert.equal(emissionSplitWindowLabel(null), "30d");
  });

  test("an unsupported window is a stated error, not a silent default", () => {
    for (const bad of ["1y", "all", "31d"]) {
      const parsed = parseEmissionSplitHistoryWindow(bad);
      assert.ok("error" in parsed && parsed.error, `${String(bad)}`);
    }
    // A NON-STRING is treated as absent and defaults, matching
    // parseSubnetYieldHistoryWindow. It is unreachable in practice — the MCP
    // input schema types `window` as a string enum and the GraphQL arg is
    // String, so a number is rejected before it reaches here — but the
    // fallback is the documented behaviour rather than an error.
    assert.deepEqual(parseEmissionSplitHistoryWindow(7), {
      label: "30d",
      days: 30,
    });
    assert.deepEqual(parseEmissionSplitHistoryWindow(null), {
      label: "30d",
      days: 30,
    });
    const parsed = parseEmissionSplitHistoryWindow("1y");
    assert.equal(
      "error" in parsed && parsed.error?.parameter,
      "window",
      "the analyticsQueryError shape carries which parameter failed",
    );
  });
});

describe("the contract", () => {
  test("the builder's output validates against the served schema", () => {
    const out = buildSubnetEmissionSplitHistory(
      [...sn74Day("2026-08-12"), ...sn74Day("2026-08-11")],
      74,
      { window: "30d" },
    );
    const parsed = SubnetEmissionSplitHistoryArtifactSchema.safeParse(out);
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });

  test("an empty series validates too", () => {
    assert.equal(
      SubnetEmissionSplitHistoryArtifactSchema.safeParse(
        buildSubnetEmissionSplitHistory([], 74, { window: "7d" }),
      ).success,
      true,
    );
  });

  test("field_sources rides with the payload, from the builder", () => {
    // Emitted once, by the builder, so REST/MCP/GraphQL publish byte-identical
    // provenance instead of three copies free to drift.
    const out = buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {});
    assert.deepEqual(out.field_sources, SUBNET_EMISSION_SPLIT_FIELD_SOURCES);
    // The measured/reconstructed line is the point of the map.
    assert.equal(
      SUBNET_EMISSION_SPLIT_FIELD_SOURCES["points.validator_alpha"].kind,
      "measured",
    );
    assert.equal(
      SUBNET_EMISSION_SPLIT_FIELD_SOURCES["points.owner_alpha"].kind,
      "reconstructed",
    );
    assert.equal(
      SUBNET_EMISSION_SPLIT_FIELD_SOURCES["points.owner_share"].kind,
      "reconstructed",
    );
  });
});

describe("the burn leg (#11094)", () => {
  test("the burn sink's emission is its own leg, not the miners'", () => {
    const rows: Row[] = sn74Day("2026-08-12").map((r) => ({
      ...r,
      hotkey: "5M",
    }));
    rows.push({
      snapshot_date: "2026-08-12",
      alpha_out_emission: 1,
      alpha_price_tao: 0.0135,
      hotkey: "5OwnerHot",
      validator_permit: false,
      emission_tao: 200,
    });
    const out = buildSubnetEmissionSplitHistory(rows, 13, {
      burnHotkey: "5OwnerHot",
    });
    const p = (out.points as Row[])[0];
    assert.equal(p.burned_alpha, 200);
    assert.ok(Math.abs((p.miner_alpha as number) - 34.5096) < 1e-6);
    // The sink is in neither population.
    assert.equal(p.miner_count, 6);
    // The three shares of the UID set sum to 1.
    const sum =
      (p.validator_share_of_uid as number) +
      (p.miner_share_of_uid as number) +
      (p.burned_share_of_uid as number);
    assert.ok(Math.abs(sum - 1) < 1e-6, String(sum));
  });

  test("no burn hotkey: burned_alpha is zero and nothing moves", () => {
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    assert.equal(p.burned_alpha, 0);
    assert.equal(p.burned_share_of_uid, 0);
  });
});

describe("the USD legs (#11095)", () => {
  test("derived from the day totals, the measured shares, and the day's rate", () => {
    const out = buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {
      usdPerTaoByDay: new Map([["2026-08-12", 400]]),
    });
    const p = (out.points as Row[])[0];
    assert.equal(p.tao_usd, 400);
    // total 7200 alpha x price 0.0135 x 400 usd.
    assert.ok(
      Math.abs((p.total_usd_day as number) - 7200 * 0.0135 * 400) < 1e-3,
    );
    // The three distributable legs plus the owner leg reassemble the total.
    const sum =
      (p.owner_usd_day as number) +
      (p.validator_usd_day as number) +
      (p.miner_usd_day as number) +
      (p.burned_usd_day as number);
    assert.ok(Math.abs(sum - (p.total_usd_day as number)) < 1e-3, String(sum));
  });

  test("a day without a priced observation nulls every USD leg, never zeroes", () => {
    const p = (
      buildSubnetEmissionSplitHistory(sn74Day("2026-08-12"), 74, {})
        .points as Row[]
    )[0];
    assert.equal(p.tao_usd, null);
    assert.equal(p.total_usd_day, null);
    assert.equal(p.miner_usd_day, null);
  });
});
