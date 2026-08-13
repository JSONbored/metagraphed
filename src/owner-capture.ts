// #10929: how much of a subnet's emission reaches the owner, measured rather
// than assumed.
//
// ## WHY THE 18% FIGURE IS NOT THE ANSWER
//
// If the protocol's owner cut were the whole story, owner-attributed emission
// would cluster tightly around 18%. Measured across 128 subnets from the live
// metagraph it does not: the median is 43.6%, 102 of 128 are above 20%, and
// exactly TWO sit in the 16-20% band the protocol cut alone would produce.
//
// Owners reach emission through routes the 18% does not describe, and WHICH
// route varies subnet by subnet. So this module detects the mechanism rather
// than assuming one -- and stops at the mechanisms the chain actually shows.
//
// ## THE LAYERS, AND WHERE THIS ONE STOPS
//
//   L1  protocol owner cut, 18%                     chain-visible   -- here
//   L2  emission on UIDs held by the owner coldkey  chain-visible   -- here
//   L3  self-stake vs nominator stake behind those  needs judgement -- NOT here
//   L4  application-layer treasury allocation       not on chain    -- NOT here
//   L5  root delegation                             not on this     -- stated
//
// L1 and L2 are pure chain readings. L3 requires deciding whether an unlabelled
// coldkey belongs to the team, and that decision is governed by
// schemas-src/attribution.ts and the published method statement at
// apps/ui/content/docs/attribution-method.mdx. A large nominator behind an
// owner-run validator has at least four innocent explanations before "hidden
// team wallet" -- a custodial exchange, a delegation service, an unaffiliated
// whale, a DAO treasury -- and every one produces the IDENTICAL on-chain shape.
//
// So this module publishes `nominator_share` as a MEASURED fraction with no
// interpretation attached, and every coldkey that is not the declared owner
// reports `verdict: "unresolved"`. That is not a hedge; it is the honest answer
// for a coldkey nobody has established a relationship for, and rendering it as
// a negative would be the defamation exposure the method statement exists to
// prevent.
//
// ## NAMING CARRIES THE EPISTEMICS
//
// `owner_attributed_share`, not `owner_captured_share` and not `owner_takes`.
// The measurement is "emission landed on UIDs whose coldkey is the declared
// owner's". What the owner ultimately KEEPS depends on L3 and L4, which this
// module cannot see. A field named for the stronger claim would be quoted as
// the stronger claim.
//
// Pure shaping only, like src/emission-split.ts: the rows arrive from
// workers/data-api.ts, so the same rows always produce the same payload.
import {
  ATTRIBUTION_VERDICT_VALUES,
  DEFAULT_ATTRIBUTION_VERDICT,
} from "../schemas-src/attribution.ts";
import {
  finiteCellOrNull,
  nonNegativeCellOrNull,
  raoBigToTao,
  round9,
  toRaoBig,
} from "./lib/rao.ts";
import { BLOCKS_PER_DAY, OWNER_CUT } from "./revenue-coverage.ts";
import {
  DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW,
  SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
} from "./route-limits.ts";

type Row = Record<string, unknown>;

/**
 * Same cap and same reason as the emission-split read this shares a table with:
 * ~256 UIDs x 90d leaves head room, and a truncated oldest day is dropped so
 * every published point covers a whole day.
 */
export const OWNER_CAPTURE_HISTORY_ROW_CAP = 50_000;

/**
 * How close a hotkey's `share_fraction` values must sum to 1 before the split
 * behind it is publishable.
 *
 * THIS IS THE COMPLETENESS PROOF, and it is self-contained on purpose. The
 * fractions partition one hotkey's stake, so they sum to 1 exactly when the
 * position set for that hotkey is whole. If rows are missing, they sum short --
 * and `nominator_share = 1 - owner_stake_share` computed over a short sum
 * OVERSTATES the nominator side, which is the direction that makes an owner
 * look less invested in their own subnet than they are.
 *
 * A sentinel table would answer "was the capture pass complete network-wide";
 * this answers "is THIS hotkey's set whole", which is the question the figure
 * actually depends on.
 */
export const STAKE_SHARE_COMPLETENESS_TOLERANCE = 0.005;

export const SUBNET_OWNER_CAPTURE_FIELD_SOURCES = {
  owner_coldkey: {
    kind: "measured",
    storage: "SubtensorModule.SubnetOwner",
  },
  "points.owner_cut_share": { kind: "reconstructed", storage: null },
  "points.owner_uid_count": { kind: "measured", storage: "neuron_daily" },
  "points.owner_uid_alpha": { kind: "measured", storage: "neuron_daily" },
  "points.uid_alpha": { kind: "measured", storage: "neuron_daily" },
  "points.owner_attributed_share_of_uid": {
    kind: "measured",
    storage: "neuron_daily",
  },
  "points.total_alpha": { kind: "reconstructed", storage: null },
  "points.owner_attributed_share": { kind: "reconstructed", storage: null },
  "points.owner_combined_share": { kind: "reconstructed", storage: null },
  "owner_uids.emission_tao": { kind: "measured", storage: "neuron_daily" },
  "owner_uids.take": {
    kind: "measured",
    storage: "SubtensorModule.Delegates",
  },
  "owner_uids.owner_stake_share": {
    kind: "measured",
    storage: "nominator_positions",
  },
  "owner_uids.nominator_share": {
    kind: "measured",
    storage: "nominator_positions",
  },
  "attribution.verdict": { kind: "measured", storage: null },
} as const;

/**
 * What this measurement CANNOT see, stated in the payload rather than only in
 * the docs.
 *
 * A caller reading `owner_attributed_share: 0.31` off an agent has no way to
 * know which mechanisms were out of frame unless the payload says so. Docs are
 * not in the response, and the response is what gets quoted.
 */
export const OWNER_CAPTURE_BLIND_SPOTS = [
  {
    layer: "L3",
    summary:
      "Whether the stake behind an owner-held validator belongs to the team. `nominator_share` is published as a measured fraction; who those nominators are is not resolved here.",
  },
  {
    layer: "L4",
    summary:
      "Application-layer treasury allocations — a cut taken in the subnet's own codebase before or after emission. Not observable on chain at all.",
  },
  {
    layer: "L5",
    summary:
      "Root delegation. Stake the owner holds on netuid 0 is not visible to this subnet's metagraph, so emission reaching them that way is out of frame.",
  },
] as const;

/** Postgres `true` vs the SQLite double's `1`. Same coercion, same reason, as
 * src/emission-split.ts: a `validator_permit` misread moves a UID between the
 * two legs the surface exists to separate. */
function isValidator(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Parse `?window`. Shares the emission-split vocabulary deliberately: this
 * series is read off the same table over the same days, and two spellings for
 * one window is how two surfaces start disagreeing about the same subnet. */
export function parseOwnerCaptureWindow(
  value: unknown,
):
  | { label: string; days: number; error?: undefined }
  | { error: { parameter: string; message: string } } {
  const v =
    typeof value === "string" && value
      ? value
      : DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW;
  if (
    !Object.prototype.hasOwnProperty.call(
      SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
      v,
    )
  ) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(
          SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS,
        ).join(", ")}.`,
      },
    };
  }
  return { label: v, days: SUBNET_EMISSION_SPLIT_HISTORY_WINDOW_DAYS[v] };
}

/** The window label a payload should carry, defaulted. Extracted so the `??`
 * arm is reachable from a test rather than being an unexercised branch. */
export function ownerCaptureWindowLabel(
  window: string | null | undefined,
): string {
  return window ?? DEFAULT_SUBNET_EMISSION_SPLIT_HISTORY_WINDOW;
}

/**
 * One day's rows reduced to the two measured legs and their reconstruction.
 *
 * `ownerColdkey` null (no ownership row) yields a point with the population
 * counts and `uid_alpha` intact and every owner field null -- NOT zero. "We do
 * not know who owns this subnet" and "the owner holds no UIDs" are different
 * facts, and zero is the one that reads as an answer.
 */
function ownerCapturePoint(
  date: string,
  dayRows: Row[],
  ownerColdkey: string | null,
  ownerCut: number,
): Row {
  let uidRao = 0n;
  let ownerRao = 0n;
  let ownerUidCount = 0;
  let alphaOutPerBlock: number | null = null;

  for (const row of dayRows) {
    alphaOutPerBlock ??= nonNegativeCellOrNull(row?.alpha_out_emission);
    const emission = nonNegativeCellOrNull(row?.emission_tao);
    // A row with no emission cell is still a registered UID. Same rule as the
    // emission split: it counts toward the population and toward "earning
    // zero"; skipping it would shrink the denominator.
    const rao = emission === null ? 0n : toRaoBig(emission);
    uidRao += rao;
    if (ownerColdkey !== null && text(row?.coldkey) === ownerColdkey) {
      ownerUidCount += 1;
      ownerRao += rao;
    }
  }

  const uidAlpha = raoBigToTao(uidRao);
  const ownerUidAlpha = raoBigToTao(ownerRao);

  // MEASURED and parameter-free: a ratio of two observed sums. Null rather than
  // 0/0 on a day that emitted nothing to any UID -- 0 would read as "the owner
  // received none of it", which is a claim about a day with nothing to receive.
  const attributedShareOfUid =
    ownerColdkey === null || uidAlpha <= 0
      ? null
      : round9(ownerUidAlpha / uidAlpha);

  // The RECONSTRUCTED half. The owner cut is paid outside the UID set, so the
  // day's whole is `alpha_out_emission x BLOCKS_PER_DAY` -- never the sum of
  // the rows, which is the distributable 82% and would inflate every share by
  // 1/(1-cut). Computed as one guarded object so the null case is expressed
  // once. Same basis as /owner-cut and /emission-split/history, so the three
  // cannot disagree about what a day of emission is.
  const totals =
    alphaOutPerBlock === null
      ? null
      : (() => {
          const total = alphaOutPerBlock * BLOCKS_PER_DAY;
          return { total, owner: total * ownerCut };
        })();

  const attributedShare =
    totals === null || totals.total <= 0 || ownerColdkey === null
      ? null
      : round9(ownerUidAlpha / totals.total);

  return {
    snapshot_date: date,
    neuron_count: dayRows.length,
    // L1. The protocol cut, which every subnet pays and no subnet chooses.
    owner_cut_share: round9(ownerCut),
    owner_cut_alpha: totals === null ? null : round9(totals.owner),
    // L2. Emission that landed on UIDs the owner coldkey holds.
    owner_uid_count: ownerColdkey === null ? null : ownerUidCount,
    owner_uid_alpha: ownerColdkey === null ? null : round9(ownerUidAlpha),
    uid_alpha: round9(uidAlpha),
    total_alpha: totals === null ? null : round9(totals.total),
    owner_attributed_share_of_uid: attributedShareOfUid,
    owner_attributed_share: attributedShare,
    // L1 + L2 over one denominator. Named for the arithmetic it is, not for
    // what the owner ends up keeping -- that is L3/L4 and out of frame.
    owner_combined_share:
      attributedShare === null ? null : round9(ownerCut + attributedShare),
  };
}

/**
 * The stake split behind one owner-held validator hotkey.
 *
 * Returns nulls with a stated reason rather than a number whenever the position
 * set for that hotkey is not provably whole -- see
 * STAKE_SHARE_COMPLETENESS_TOLERANCE. An incomplete set does not produce a
 * wrong-looking figure, it produces a plausible one.
 */
function stakeSplitFor(
  hotkey: string | null,
  // NON-NULL by construction: ownerUidRows returns early when the owner is
  // unknown, so this is only ever called with one. Typed that way rather than
  // guarded, because a guard nothing can reach reads as a tested branch.
  ownerColdkey: string,
  positions: Row[],
): {
  owner_stake_share: number | null;
  nominator_share: number | null;
  stake_split_reason: string | null;
} {
  const none = (reason: string) => ({
    owner_stake_share: null,
    nominator_share: null,
    stake_split_reason: reason,
  });
  if (hotkey === null) return none("no hotkey on the UID row");
  const mine = positions.filter((p) => text(p?.hotkey) === hotkey);
  if (mine.length === 0) return none("no stake positions captured");

  let sum = 0;
  let ownerSum = 0;
  for (const position of mine) {
    const fraction = finiteCellOrNull(position?.share_fraction);
    if (fraction === null) continue;
    sum += fraction;
    if (text(position?.coldkey) === ownerColdkey) ownerSum += fraction;
  }
  if (Math.abs(sum - 1) > STAKE_SHARE_COMPLETENESS_TOLERANCE) {
    return none(
      `captured stake shares sum to ${round9(sum)}, not 1 — the position set for this hotkey is incomplete`,
    );
  }
  return {
    owner_stake_share: round9(ownerSum),
    nominator_share: round9(1 - ownerSum),
    stake_split_reason: null,
  };
}

/**
 * The owner-held UIDs on the newest day, and who is staked behind them.
 *
 * Newest day only, deliberately: this is a "who is behind it right now" list,
 * and a UID set unioned across a month would list neurons that have since
 * deregistered as though they were current.
 */
function ownerUidRows(
  dayRows: Row[],
  ownerColdkey: string | null,
  positions: Row[],
): Row[] {
  if (ownerColdkey === null) return [];
  const out: Row[] = [];
  for (const row of dayRows) {
    if (text(row?.coldkey) !== ownerColdkey) continue;
    const hotkey = text(row?.hotkey);
    const isVali = isValidator(row?.validator_permit);
    out.push({
      uid: finiteCellOrNull(row?.uid),
      hotkey,
      validator_permit: isVali,
      emission_tao: nonNegativeCellOrNull(row?.emission_tao),
      // NOT `?? 0`. `take` is global per hotkey (SubtensorModule::Delegates)
      // and null means NO Delegates entry at capture, which is a different
      // fact from a 0% commission. Rendering it as zero would publish a
      // commission nobody set.
      take: finiteCellOrNull(row?.take),
      // Only a validator has nominators; a miner UID has no stake split to
      // report, and an empty one there would read as "nobody is staked".
      ...(isVali
        ? stakeSplitFor(hotkey, ownerColdkey, positions)
        : {
            owner_stake_share: null,
            nominator_share: null,
            stake_split_reason: "not a validator UID",
          }),
    });
  }
  return out.sort((a, b) => Number(a.uid ?? 0) - Number(b.uid ?? 0));
}

/**
 * Every coldkey staked behind the owner's validator UIDs, with its verdict.
 *
 * EVERY ONE OF THEM IS `unresolved` EXCEPT THE OWNER ITSELF, and that is
 * structural, not a default this module could drift away from: nothing here
 * computes a verdict. The vocabulary comes from schemas-src/attribution.ts,
 * where the schema refuses to serialise anything above `unresolved` without an
 * evidence object -- so a future heuristic cannot quietly promote a coldkey by
 * editing this file alone.
 */
function attributionRows(
  ownerColdkey: string | null,
  ownerHotkeys: Set<string>,
  positions: Row[],
): Row[] {
  const seen = new Map<string, number>();
  for (const position of positions) {
    const hotkey = text(position?.hotkey);
    if (hotkey === null || !ownerHotkeys.has(hotkey)) continue;
    const coldkey = text(position?.coldkey);
    if (coldkey === null) continue;
    const fraction = finiteCellOrNull(position?.share_fraction) ?? 0;
    seen.set(coldkey, (seen.get(coldkey) ?? 0) + fraction);
  }
  return [...seen.entries()]
    .map(([coldkey, share]) => ({
      coldkey,
      stake_share: round9(share),
      // `owner` is the ONLY verdict this module can assign, because the chain
      // read IS the evidence for it -- SubtensorModule.SubnetOwner. Everything
      // else is `unresolved`, which is the default and not a failure state.
      verdict: coldkey === ownerColdkey ? "owner" : DEFAULT_ATTRIBUTION_VERDICT,
      evidence: [] as unknown[],
    }))
    .sort((a, b) => b.stake_share - a.stake_share);
}

/**
 * Build the owner-capture card (points newest first) from `neuron_daily` rows
 * ordered `snapshot_date DESC`.
 *
 * Null-safe throughout: a cold store, an absent ownership row and an empty
 * position set are all real states that answer rather than throw.
 */
export function buildSubnetOwnerCapture(
  rows: Row[] | null | undefined,
  netuid: unknown,
  {
    window,
    capped,
    ownerColdkey = null,
    positions,
    ownerCut = OWNER_CUT,
  }: {
    window?: string;
    capped?: boolean;
    ownerColdkey?: string | null;
    positions?: Row[] | null;
    ownerCut?: number;
  } = {},
): Row {
  const list = Array.isArray(rows) ? rows : [];
  const positionList = Array.isArray(positions) ? positions : [];
  const owner = text(ownerColdkey);

  const byDate = new Map<string, Row[]>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(row);
  }
  let days = [...byDate.entries()];
  if (capped && days.length > 1) days = days.slice(0, -1);

  const effectiveCut =
    Number.isFinite(ownerCut) && ownerCut >= 0 && ownerCut <= 1
      ? ownerCut
      : OWNER_CUT;

  const points = days.map(([date, dayRows]) =>
    ownerCapturePoint(date, dayRows, owner, effectiveCut),
  );

  // Rows arrive newest-first, so the first entry is the newest day.
  const newest = days.length > 0 ? days[0][1] : [];
  const uids = ownerUidRows(newest, owner, positionList);
  const ownerHotkeys = new Set(
    uids
      .filter((u) => u.validator_permit === true)
      .map((u) => u.hotkey)
      .filter((h): h is string => typeof h === "string"),
  );

  return {
    schema_version: 1,
    netuid,
    window: ownerCaptureWindowLabel(window),
    owner_coldkey: owner,
    point_count: points.length,
    points,
    owner_uid_count: owner === null ? null : uids.length,
    owner_uids: uids,
    attribution: attributionRows(owner, ownerHotkeys, positionList),
    // The vocabulary is published WITH the verdicts, so a caller can tell that
    // `unresolved` is one of four defined states rather than a missing value.
    attribution_vocabulary: ATTRIBUTION_VERDICT_VALUES,
    blind_spots: OWNER_CAPTURE_BLIND_SPOTS,
    field_sources: SUBNET_OWNER_CAPTURE_FIELD_SOURCES,
  };
}
