import type { GlobalValidator } from "./types";

/**
 * A named operator, and the keys it runs.
 *
 * The directory used to rank 1,022 hotkeys, scattering one operator across as
 * many as 105 rows. But nobody picks "one of Yuma's 86 hotkeys" — they pick
 * Yuma, and then a subnet, and the hotkey is whichever key Yuma runs there.
 * 148 named identities cover 85.7% of network stake, so the identity is the
 * useful top-level unit and its keys are the detail (#11522).
 */
export interface ValidatorIdentity {
  /** Declared identity name, trimmed. Stable key for this group. */
  name: string;
  url: string | null;
  image: string | null;
  description: string | null;
  /** Its hotkeys, largest stake first. Each still links to its own page. */
  members: GlobalValidator[];
  /** Distinct hotkeys. Exact. */
  hotkeyCount: number;
  /**
   * (hotkey, subnet) pairs this operator holds — the sum of each key's own
   * `subnet_count`.
   *
   * This is the additive unit, and it is deliberately NOT "distinct subnets".
   * The list response caps each row's `subnets[]` at 10 entries (12 of 1,022
   * live rows are truncated — tao.bot reports subnet_count 116 with 10 array
   * entries), so a union over those arrays would silently under-report. A
   * position is a key on a subnet; those are distinct by construction, so
   * summing them is exact whatever the arrays contain.
   */
  subnetPositions: number;
  /** Sum across hotkeys. Stake is additive, so this is a real total. */
  totalStakeTao: number;
  /**
   * Take and APY vary BETWEEN one operator's hotkeys — Yuma runs both 9% and
   * 18% — so a single blended figure would be a rate nobody is charged.
   * Ranges only, and `null` when nothing was reported.
   */
  takeRange: [number, number] | null;
  apyRange: [number, number] | null;
}

export interface ValidatorIdentityIndex {
  /** Named operators, ranked by total stake, largest first. */
  identities: ValidatorIdentity[];
  /**
   * Hotkeys with no declared identity. Deliberately NOT merged into one row:
   * they are unrelated operators that share only the absence of a name.
   */
  unnamed: GlobalValidator[];
  /** Share of observed stake the named identities account for. */
  namedStakeShare: number;
}

function declaredName(validator: GlobalValidator): string | null {
  const identity = validator.coldkey_identity;
  if (!identity?.has_identity) return null;
  const name = typeof identity.name === "string" ? identity.name.trim() : "";
  return name.length > 0 ? name : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rangeOf(values: readonly number[]): [number, number] | null {
  if (values.length === 0) return null;
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Groups a validator list into named operators plus the unnamed remainder.
 *
 * Only additive facts are summed. Anything that varies between an operator's
 * own hotkeys is a range, and nominator counts are deliberately absent: one
 * delegator can back several of an operator's keys, so adding the per-key
 * counts would report more distinct people than exist.
 */
export function buildValidatorIdentityIndex(
  rows: readonly GlobalValidator[],
): ValidatorIdentityIndex {
  const byName = new Map<string, GlobalValidator[]>();
  const unnamed: GlobalValidator[] = [];

  for (const row of rows) {
    const name = declaredName(row);
    if (!name) {
      unnamed.push(row);
      continue;
    }
    const group = byName.get(name);
    if (group) group.push(row);
    else byName.set(name, [row]);
  }

  const identities: ValidatorIdentity[] = [];
  for (const [name, group] of byName) {
    const members = [...group].sort(
      (a, b) => (finite(b.total_stake_tao) ?? 0) - (finite(a.total_stake_tao) ?? 0),
    );
    const identity = members[0]?.coldkey_identity;

    identities.push({
      name,
      url: typeof identity?.url === "string" ? identity.url : null,
      image: typeof identity?.image === "string" ? identity.image : null,
      description: typeof identity?.description === "string" ? identity.description : null,
      members,
      hotkeyCount: new Set(
        members.map((m) => m.hotkey).filter((h): h is string => typeof h === "string"),
      ).size,
      subnetPositions: members.reduce(
        (total, member) => total + (finite(member.subnet_count) ?? 0),
        0,
      ),
      totalStakeTao: members.reduce(
        (total, member) => total + (finite(member.total_stake_tao) ?? 0),
        0,
      ),
      takeRange: rangeOf(members.map((m) => finite(m.take)).filter((v): v is number => v !== null)),
      apyRange: rangeOf(
        members.map((m) => finite(m.apy_estimate)).filter((v): v is number => v !== null),
      ),
    });
  }

  identities.sort((a, b) => b.totalStakeTao - a.totalStakeTao || a.name.localeCompare(b.name));

  const observedStake = rows.reduce((total, row) => total + (finite(row.total_stake_tao) ?? 0), 0);
  const namedStake = identities.reduce((total, entry) => total + entry.totalStakeTao, 0);

  return {
    identities,
    unnamed,
    namedStakeShare: observedStake > 0 ? namedStake / observedStake : 0,
  };
}

/** "9%" for a single rate, "9–18%" when an operator's keys differ. */
export function formatRatePercentRange(
  range: [number, number] | null,
  fractionDigits = 1,
): string | null {
  if (!range) return null;
  const [low, high] = range;
  const format = (value: number) => (value * 100).toFixed(fractionDigits);
  const lowText = format(low);
  const highText = format(high);
  return lowText === highText ? `${lowText}%` : `${lowText}–${highText}%`;
}
