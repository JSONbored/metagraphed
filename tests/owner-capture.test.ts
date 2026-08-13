// src/owner-capture.ts — L1 + L2, and the things this surface must never say.
//
// Roughly half of these tests are about the ARITHMETIC and half are about the
// EPISTEMICS, and the second half is the load-bearing one. A wrong revenue
// figure is an error; "this team is quietly taking 60%" is not retractable
// once an agent has quoted it. So the claims below are written against the
// ways this surface could overstate rather than against the happy path.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetOwnerCapture,
  ownerCaptureWindowLabel,
  parseOwnerCaptureWindow,
  OWNER_CAPTURE_BLIND_SPOTS,
  STAKE_SHARE_COMPLETENESS_TOLERANCE,
  SUBNET_OWNER_CAPTURE_FIELD_SOURCES,
} from "../src/owner-capture.ts";
import { OWNER_CUT } from "../src/revenue-coverage.ts";
import { round9 } from "../src/lib/rao.ts";

// Everything published is on the rao grid (9dp), so the expected values here
// are rounded too. Comparing against the raw constant would be asserting a
// precision the payload deliberately does not carry.
const CUT = round9(OWNER_CUT);
import { ATTRIBUTION_VERDICT_VALUES } from "../schemas-src/attribution.ts";

const OWNER = "5Owner";
const OUTSIDER = "5Outsider";

type Row = Record<string, unknown>;

/** One neuron-day. `alpha_out_emission` rides on every row via the join. */
function row(over: Row = {}): Row {
  return {
    snapshot_date: "2026-08-12",
    uid: 0,
    hotkey: "5HotA",
    coldkey: OUTSIDER,
    validator_permit: false,
    emission_tao: 0,
    take: null,
    alpha_out_emission: 1,
    ...over,
  };
}

describe("L2 — emission on owner-held UIDs", () => {
  test("is the owner's share of the observed per-UID emission", () => {
    // 30 of 100 alpha across the UID set landed on the owner's UID.
    const out = buildSubnetOwnerCapture(
      [
        row({ uid: 0, coldkey: OWNER, emission_tao: 30 }),
        row({ uid: 1, emission_tao: 40 }),
        row({ uid: 2, emission_tao: 30 }),
      ],
      74,
      { ownerColdkey: OWNER },
    );
    const p = (out.points as Row[])[0];
    assert.equal(p.uid_alpha, 100);
    assert.equal(p.owner_uid_alpha, 30);
    assert.equal(p.owner_uid_count, 1);
    // MEASURED and parameter-free — no owner-cut assumption in this one.
    assert.equal(p.owner_attributed_share_of_uid, 0.3);
  });

  test("THE WHOLE-DAY DENOMINATOR IS NOT THE SUM OF THE ROWS", () => {
    // The trap src/emission-split.ts documents. The owner cut is paid OUTSIDE
    // the UID set, so per-UID rows sum to the distributable ~82%. Dividing by
    // that would inflate every share by 1/(1-cut) -- about 22% relative, which
    // is exactly the size of error that looks plausible.
    const out = buildSubnetOwnerCapture(
      [
        row({ uid: 0, coldkey: OWNER, emission_tao: 30 }),
        row({ uid: 1, emission_tao: 70 }),
      ],
      74,
      { ownerColdkey: OWNER },
    );
    const p = (out.points as Row[])[0];
    // alpha_out_emission 1 x 7200 blocks = 7200 alpha for the whole day.
    assert.equal(p.total_alpha, 7200);
    assert.equal(p.owner_attributed_share, round9(30 / 7200));
    // ...and it is strictly BELOW the share-of-UID, never equal to it. If the
    // two ever coincide the denominator has collapsed to the row sum.
    assert.ok(
      (p.owner_attributed_share as number) <
        (p.owner_attributed_share_of_uid as number),
    );
  });

  test("owner_combined_share is L1 + L2, and says so arithmetically", () => {
    const out = buildSubnetOwnerCapture(
      [row({ uid: 0, coldkey: OWNER, emission_tao: 720 })],
      74,
      { ownerColdkey: OWNER },
    );
    const p = (out.points as Row[])[0];
    assert.equal(p.owner_cut_share, CUT);
    assert.equal(p.owner_attributed_share, 0.1);
    assert.ok(
      Math.abs((p.owner_combined_share as number) - (CUT + 0.1)) < 1e-9,
    );
  });

  test("the owner cut is the runtime default, not 1/6", () => {
    // 11796/65535 = 0.17999... A second copy of this constant getting it
    // wrong is worth ~6 TAO/day on SN64, and 1/6 is the plausible wrong value.
    const p = (
      buildSubnetOwnerCapture([row()], 74, { ownerColdkey: OWNER })
        .points as Row[]
    )[0];
    assert.equal(p.owner_cut_share, CUT);
    assert.notEqual(p.owner_cut_share, 1 / 6);
    assert.ok(Math.abs((p.owner_cut_share as number) - 0.18) < 0.001);
  });
});

describe("the expected outcome, stated falsifiably in #10929", () => {
  test("a subnet whose owner holds NO UID reports 0 with an empty list", () => {
    // A REAL MEASUREMENT, and the issue is explicit that it must be
    // distinguishable from null. The owner is known; they simply run nothing.
    const out = buildSubnetOwnerCapture(
      [row({ uid: 0, emission_tao: 50 }), row({ uid: 1, emission_tao: 50 })],
      12,
      { ownerColdkey: OWNER },
    );
    const p = (out.points as Row[])[0];
    assert.equal(p.owner_uid_count, 0);
    assert.equal(p.owner_uid_alpha, 0);
    assert.equal(p.owner_attributed_share_of_uid, 0);
    assert.equal(p.owner_attributed_share, 0);
    assert.deepEqual(out.owner_uids, []);
    assert.equal(out.owner_uid_count, 0);
  });

  test("AN UNKNOWN OWNER IS NULL, NOT ZERO", () => {
    // The distinction the test above exists to protect. "Nobody has captured
    // an ownership row" and "the owner runs nothing here" are different facts,
    // and zero is the one that reads as an answer about the team.
    const out = buildSubnetOwnerCapture(
      [row({ uid: 0, emission_tao: 50 })],
      12,
      { ownerColdkey: null },
    );
    const p = (out.points as Row[])[0];
    assert.equal(out.owner_coldkey, null);
    assert.equal(out.owner_uid_count, null);
    assert.equal(p.owner_uid_count, null);
    assert.equal(p.owner_uid_alpha, null);
    assert.equal(p.owner_attributed_share_of_uid, null);
    assert.equal(p.owner_attributed_share, null);
    assert.equal(p.owner_combined_share, null);
    // The measured leg that does NOT depend on knowing the owner survives.
    assert.equal(p.uid_alpha, 50);
  });

  test("a day that emitted nothing declines rather than reporting 0", () => {
    // 0/0. Zero would read as "the owner received none of it", which is a
    // claim about a day with nothing to receive.
    const p = (
      buildSubnetOwnerCapture(
        [row({ uid: 0, coldkey: OWNER, emission_tao: 0 })],
        74,
        { ownerColdkey: OWNER },
      ).points as Row[]
    )[0];
    assert.equal(p.uid_alpha, 0);
    assert.equal(p.owner_attributed_share_of_uid, null);
    // The UID is still counted -- it is registered, it just earned nothing.
    assert.equal(p.owner_uid_count, 1);
    assert.equal(p.neuron_count, 1);
  });
});

describe("attribution — what this surface refuses to conclude", () => {
  const positions = [
    { coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: 0.9977 },
    { coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.0023 },
  ];

  test("A 99.77% NON-OWNER NOMINATOR IS `unresolved`, WITH NO EVIDENCE", () => {
    // THE CENTRAL CLAIM. This is SN74's real shape, and it is exactly the
    // input a heuristic would be tempted to promote to "hidden team wallet".
    // Four innocent explanations produce the identical on-chain shape.
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 0,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
          emission_tao: 315,
        }),
      ],
      74,
      { ownerColdkey: OWNER, positions },
    );
    const whale = (out.attribution as Row[]).find(
      (a) => a.coldkey === OUTSIDER,
    ) as Row;
    assert.equal(whale.verdict, "unresolved");
    assert.deepEqual(whale.evidence, []);
    assert.equal(whale.stake_share, 0.9977);
  });

  test("the owner itself is the ONLY promoted verdict", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 0,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      { ownerColdkey: OWNER, positions },
    );
    const rows = out.attribution as Row[];
    assert.equal(rows.find((a) => a.coldkey === OWNER)?.verdict, "owner");
    // NOTHING ELSE, EVER. Asserted over the whole list rather than the one row,
    // so a future heuristic promoting a second coldkey fails here.
    for (const r of rows) {
      if (r.coldkey === OWNER) continue;
      assert.equal(r.verdict, "unresolved", `${String(r.coldkey)} promoted`);
    }
  });

  test("the surface CANNOT emit affiliated or third-party at all", () => {
    // A stronger form of the above: not "does not today", but "has no code
    // path that does". Driven over a spread of shapes a heuristic might key
    // on -- a dominant holder, a tiny one, an exact tie, many holders.
    const shapes: Row[][] = [
      [{ coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: 1 }],
      [
        { coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: 0.5 },
        { coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.5 },
      ],
      [
        { coldkey: "5A", hotkey: "5HotA", share_fraction: 0.25 },
        { coldkey: "5B", hotkey: "5HotA", share_fraction: 0.25 },
        { coldkey: "5C", hotkey: "5HotA", share_fraction: 0.25 },
        { coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.25 },
      ],
    ];
    for (const shape of shapes) {
      const out = buildSubnetOwnerCapture(
        [
          row({
            uid: 0,
            coldkey: OWNER,
            hotkey: "5HotA",
            validator_permit: true,
          }),
        ],
        74,
        { ownerColdkey: OWNER, positions: shape },
      );
      for (const r of out.attribution as Row[]) {
        assert.ok(
          r.verdict === "unresolved" || r.verdict === "owner",
          `emitted ${String(r.verdict)}`,
        );
      }
    }
  });

  test("the published vocabulary IS the shared one, not a local copy", () => {
    const out = buildSubnetOwnerCapture([row()], 74, { ownerColdkey: OWNER });
    assert.deepEqual(
      out.attribution_vocabulary,
      ATTRIBUTION_VERDICT_VALUES,
      "a local vocabulary would let this surface invent a word for a claim",
    );
  });
});

describe("nominator_share — measured, and only when provable", () => {
  test("is 1 - the owner's own stake share", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 3,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      {
        ownerColdkey: OWNER,
        positions: [
          { coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: 0.9977 },
          { coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.0023 },
        ],
      },
    );
    const uid = (out.owner_uids as Row[])[0];
    assert.equal(uid.owner_stake_share, 0.0023);
    assert.equal(uid.nominator_share, 0.9977);
    assert.equal(uid.stake_split_reason, null);
  });

  test("AN INCOMPLETE POSITION SET DECLINES RATHER THAN OVERSTATING", () => {
    // If rows are missing the fractions sum short, and `1 - ownerSum` then
    // OVERSTATES the nominator side -- the direction that makes an owner look
    // less invested in their own subnet than they are. Here only half the
    // stake is captured.
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 3,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      {
        ownerColdkey: OWNER,
        positions: [{ coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.5 }],
      },
    );
    const uid = (out.owner_uids as Row[])[0];
    assert.equal(uid.nominator_share, null);
    assert.equal(uid.owner_stake_share, null);
    assert.match(String(uid.stake_split_reason), /incomplete/);
    // The naive answer this refuses to give.
    assert.notEqual(uid.nominator_share, 0.5);
  });

  test("the tolerance admits rounding but not a missing holder", () => {
    const at = (sum: number) =>
      (
        buildSubnetOwnerCapture(
          [
            row({
              uid: 3,
              coldkey: OWNER,
              hotkey: "5HotA",
              validator_permit: true,
            }),
          ],
          74,
          {
            ownerColdkey: OWNER,
            positions: [
              { coldkey: OWNER, hotkey: "5HotA", share_fraction: sum },
            ],
          },
        ).owner_uids as Row[]
      )[0].nominator_share;
    // Just inside: float noise on a capture that really did sum to 1. The
    // published split is the residual, not a fabricated 0.
    assert.equal(
      at(1 - STAKE_SHARE_COMPLETENESS_TOLERANCE / 2),
      round9(STAKE_SHARE_COMPLETENESS_TOLERANCE / 2),
    );
    // Just outside: a holder is missing.
    assert.equal(at(1 - STAKE_SHARE_COMPLETENESS_TOLERANCE * 2), null);
  });

  test("a miner UID reports no split, with the reason stated", () => {
    const out = buildSubnetOwnerCapture(
      [row({ uid: 9, coldkey: OWNER, validator_permit: false })],
      74,
      { ownerColdkey: OWNER },
    );
    const uid = (out.owner_uids as Row[])[0];
    assert.equal(uid.nominator_share, null);
    assert.equal(uid.stake_split_reason, "not a validator UID");
  });

  test("no captured positions declines, and does not read as 'nobody staked'", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 3,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      { ownerColdkey: OWNER, positions: [] },
    );
    const uid = (out.owner_uids as Row[])[0];
    assert.equal(uid.nominator_share, null);
    assert.match(String(uid.stake_split_reason), /no stake positions/);
    assert.deepEqual(out.attribution, []);
  });
});

describe("take", () => {
  test("NULL IS NEVER RENDERED AS ZERO", () => {
    // `take` is global per hotkey; null means no Delegates entry at capture,
    // which is a different fact from a 0% commission. Requirement 6.
    const out = buildSubnetOwnerCapture(
      [
        row({ uid: 0, coldkey: OWNER, take: null, validator_permit: true }),
        row({
          uid: 1,
          coldkey: OWNER,
          hotkey: "5HotB",
          take: 0,
          validator_permit: true,
        }),
      ],
      74,
      { ownerColdkey: OWNER },
    );
    const uids = out.owner_uids as Row[];
    assert.equal(uids[0].take, null, "no Delegates entry must stay null");
    assert.equal(uids[1].take, 0, "a real 0% take is a reading and stays 0");
    assert.notEqual(uids[0].take, uids[1].take);
  });
});

describe("the blind spots are in the payload", () => {
  test("L3, L4 and L5 are each stated", () => {
    // Requirement 5: in the response, not only the docs. The response is what
    // gets quoted.
    const out = buildSubnetOwnerCapture([row()], 74, { ownerColdkey: OWNER });
    const layers = (out.blind_spots as Row[]).map((b) => b.layer);
    assert.deepEqual(layers, ["L3", "L4", "L5"]);
    for (const spot of OWNER_CAPTURE_BLIND_SPOTS) {
      assert.ok(
        spot.summary.length > 40,
        `${spot.layer} needs a real sentence`,
      );
    }
  });

  test("they are present even on an empty card", () => {
    // The failure mode: a subnet with no rollup returns a bare shell, and the
    // one thing that shell still has to carry is what it cannot see.
    const out = buildSubnetOwnerCapture([], 74);
    assert.equal(out.point_count, 0);
    assert.equal((out.blind_spots as Row[]).length, 3);
  });
});

describe("shaping", () => {
  test("groups by day, newest first, and drops a capped oldest day", () => {
    const rows = [
      row({ snapshot_date: "2026-08-12", uid: 0, emission_tao: 10 }),
      row({ snapshot_date: "2026-08-11", uid: 0, emission_tao: 20 }),
      row({ snapshot_date: "2026-08-10", uid: 0, emission_tao: 30 }),
    ];
    const full = buildSubnetOwnerCapture(rows, 74, { ownerColdkey: OWNER });
    assert.deepEqual(
      (full.points as Row[]).map((p) => p.snapshot_date),
      ["2026-08-12", "2026-08-11", "2026-08-10"],
    );
    // The oldest day is the one the cap truncated mid-population.
    const capped = buildSubnetOwnerCapture(rows, 74, {
      ownerColdkey: OWNER,
      capped: true,
    });
    assert.deepEqual(
      (capped.points as Row[]).map((p) => p.snapshot_date),
      ["2026-08-12", "2026-08-11"],
    );
  });

  test("the UID list is the NEWEST day only", () => {
    // A set unioned across the window would list neurons that have since
    // deregistered as though they were current.
    const out = buildSubnetOwnerCapture(
      [
        row({ snapshot_date: "2026-08-12", uid: 1, coldkey: OWNER }),
        row({ snapshot_date: "2026-08-11", uid: 7, coldkey: OWNER }),
      ],
      74,
      { ownerColdkey: OWNER },
    );
    assert.deepEqual(
      (out.owner_uids as Row[]).map((u) => u.uid),
      [1],
    );
  });

  test("a cold store answers rather than throwing", () => {
    for (const input of [null, undefined, []]) {
      const out = buildSubnetOwnerCapture(input, 74);
      assert.equal(out.point_count, 0);
      assert.deepEqual(out.points, []);
      assert.equal(out.owner_coldkey, null);
    }
  });

  test("validator_permit is read as Postgres true OR the SQLite 1", () => {
    // A misread moves a UID out of the class whose stake split is reported.
    for (const permit of [true, 1]) {
      const out = buildSubnetOwnerCapture(
        [
          row({
            uid: 0,
            coldkey: OWNER,
            hotkey: "5HotA",
            validator_permit: permit,
          }),
        ],
        74,
        {
          ownerColdkey: OWNER,
          positions: [{ coldkey: OWNER, hotkey: "5HotA", share_fraction: 1 }],
        },
      );
      assert.equal((out.owner_uids as Row[])[0].validator_permit, true);
      assert.equal((out.owner_uids as Row[])[0].nominator_share, 0);
    }
  });

  test("an out-of-range owner cut falls back to the chain constant", () => {
    for (const bad of [Number.NaN, -1, 2]) {
      const p = (
        buildSubnetOwnerCapture([row()], 74, {
          ownerColdkey: OWNER,
          ownerCut: bad,
        }).points as Row[]
      )[0];
      assert.equal(p.owner_cut_share, CUT, `on ${String(bad)}`);
    }
  });

  test("field_sources rides with the payload from the builder", () => {
    // Emitted here rather than per handler, so REST, MCP and GraphQL publish
    // byte-identical provenance — a per-surface copy is how one of them ends
    // up claiming a reconstruction is a reading.
    const out = buildSubnetOwnerCapture([row()], 74);
    assert.equal(out.field_sources, SUBNET_OWNER_CAPTURE_FIELD_SOURCES);
    assert.equal(
      SUBNET_OWNER_CAPTURE_FIELD_SOURCES["points.owner_attributed_share"].kind,
      "reconstructed",
    );
    assert.equal(
      SUBNET_OWNER_CAPTURE_FIELD_SOURCES["points.owner_attributed_share_of_uid"]
        .kind,
      "measured",
      "the parameter-free ratio is a reading and must not be labelled otherwise",
    );
  });
});

// Every column this reads is NULLABLE in Postgres, so "malformed" here means
// "a real row the store can legally hold" -- not a synthetic edge case. Each
// of these is the arm that decides whether a missing cell becomes a fabricated
// number or an honest absence.
describe("rows the store can legally hold", () => {
  test("a UID with no emission cell counts, and contributes nothing", () => {
    // It is a registered UID: it belongs in the population and in "earning
    // zero". Skipping it would shrink the denominator and overstate every
    // share computed against it.
    const p = (
      buildSubnetOwnerCapture(
        [
          row({ uid: 0, coldkey: OWNER, emission_tao: null }),
          row({ uid: 1, emission_tao: 10 }),
        ],
        74,
        { ownerColdkey: OWNER },
      ).points as Row[]
    )[0];
    assert.equal(p.neuron_count, 2);
    assert.equal(p.owner_uid_count, 1, "the owner's UID is still counted");
    assert.equal(p.owner_uid_alpha, 0);
    assert.equal(p.uid_alpha, 10);
  });

  test("a row with no snapshot_date is skipped, not grouped under undefined", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({ snapshot_date: "2026-08-12", uid: 0, emission_tao: 5 }),
        row({ snapshot_date: null, uid: 1 }),
        row({ snapshot_date: "", uid: 2 }),
        row({ snapshot_date: 20260812, uid: 3 }),
      ],
      74,
      { ownerColdkey: OWNER },
    );
    assert.equal(out.point_count, 1);
    assert.equal((out.points as Row[])[0].snapshot_date, "2026-08-12");
  });

  test("an owner UID with no hotkey declines its split rather than guessing", () => {
    const uid = (
      buildSubnetOwnerCapture(
        [
          row({
            uid: 0,
            coldkey: OWNER,
            hotkey: null,
            validator_permit: true,
          }),
        ],
        74,
        {
          ownerColdkey: OWNER,
          positions: [{ coldkey: OWNER, hotkey: "5HotA", share_fraction: 1 }],
        },
      ).owner_uids as Row[]
    )[0];
    assert.equal(uid.nominator_share, null);
    assert.equal(uid.stake_split_reason, "no hotkey on the UID row");
  });

  test("a position with a null share_fraction is skipped, not read as 0", () => {
    // Skipping it leaves the sum short, which the completeness guard then
    // catches -- the honest chain. Treating it as 0 would let an incomplete
    // set pass as whole.
    const uid = (
      buildSubnetOwnerCapture(
        [
          row({
            uid: 0,
            coldkey: OWNER,
            hotkey: "5HotA",
            validator_permit: true,
          }),
        ],
        74,
        {
          ownerColdkey: OWNER,
          positions: [
            { coldkey: OWNER, hotkey: "5HotA", share_fraction: 0.6 },
            { coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: null },
          ],
        },
      ).owner_uids as Row[]
    )[0];
    assert.equal(uid.nominator_share, null);
    assert.match(String(uid.stake_split_reason), /incomplete/);
  });

  test("positions with no hotkey or no coldkey do not become attribution rows", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 0,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      {
        ownerColdkey: OWNER,
        positions: [
          { coldkey: OWNER, hotkey: "5HotA", share_fraction: 1 },
          { coldkey: OUTSIDER, hotkey: null, share_fraction: 0.5 },
          { coldkey: null, hotkey: "5HotA", share_fraction: 0.5 },
          // A hotkey the owner does not hold — a different validator's
          // nominators must never be attributed to this subnet's owner.
          { coldkey: "5Elsewhere", hotkey: "5NotOwners", share_fraction: 1 },
        ],
      },
    );
    assert.deepEqual(
      (out.attribution as Row[]).map((a) => a.coldkey),
      [OWNER],
    );
  });

  test("a position with an unparseable share_fraction contributes 0", () => {
    const out = buildSubnetOwnerCapture(
      [
        row({
          uid: 0,
          coldkey: OWNER,
          hotkey: "5HotA",
          validator_permit: true,
        }),
      ],
      74,
      {
        ownerColdkey: OWNER,
        positions: [
          { coldkey: OWNER, hotkey: "5HotA", share_fraction: 1 },
          { coldkey: OUTSIDER, hotkey: "5HotA", share_fraction: "nope" },
        ],
      },
    );
    const outsider = (out.attribution as Row[]).find(
      (a) => a.coldkey === OUTSIDER,
    ) as Row;
    assert.equal(
      outsider.stake_share,
      0,
      "listed, with nothing claimed for it",
    );
  });

  test("owner UIDs sort by uid, and a null uid does not throw", () => {
    const uids = buildSubnetOwnerCapture(
      [
        row({ uid: 5, coldkey: OWNER }),
        row({ uid: null, coldkey: OWNER }),
        row({ uid: 1, coldkey: OWNER }),
      ],
      74,
      { ownerColdkey: OWNER },
    ).owner_uids as Row[];
    assert.deepEqual(
      uids.map((u) => u.uid),
      [null, 1, 5],
    );
  });
});

describe("the window", () => {
  test("shares the emission-split vocabulary", () => {
    for (const label of ["7d", "30d", "90d"]) {
      const parsed = parseOwnerCaptureWindow(label);
      assert.equal("error" in parsed, false, `rejected ${label}`);
    }
  });

  test("an unsupported window is an error naming the supported set", () => {
    const parsed = parseOwnerCaptureWindow("1d");
    assert.ok("error" in parsed && parsed.error);
    assert.equal(parsed.error?.parameter, "window");
    assert.match(String(parsed.error?.message), /7d, 30d, 90d/);
  });

  test("an absent window is the default, not an error", () => {
    const parsed = parseOwnerCaptureWindow(undefined);
    assert.equal("error" in parsed, false);
    assert.equal((parsed as { label: string }).label, "30d");
    assert.equal(ownerCaptureWindowLabel(null), "30d");
    assert.equal(ownerCaptureWindowLabel("7d"), "7d");
  });
});
