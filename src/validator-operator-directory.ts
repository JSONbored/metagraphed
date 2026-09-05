// The website-facing validator directory, derived from the full network-wide
// validator leaderboard without changing that leaderboard's public contract.
//
// `/api/v1/validators` is intentionally rich: each hotkey carries realized
// returns, identity metadata and up to ten subnet memberships for REST/MCP
// consumers that need the complete record. The directory page asks a different
// question -- which OPERATORS are active, and how much stake/emission they run
// across their keys -- so sending every rich row there wastes about 900 kB per
// refresh. This builder keeps the grouping rule in the data layer and returns
// only the fields the directory can render.

type Row = Record<string, unknown>;

export interface ValidatorOperatorKey {
  hotkey: string;
  total_stake_tao: number;
  take: number | null;
}

export interface ValidatorOperatorEntry {
  /** Stable within the response network; independent of name or primary hotkey. */
  operator_id?: string;
  /** Observed ownership agreement, never verification of a brand or organization. */
  ownership_basis?: "single_coldkey" | "ambiguous" | "unknown";
  /** Declared on-chain identity name; null means the primary hotkey is the label. */
  identity_name: string | null;
  /** Present only for a multi-key operator; a singleton's primary key is enough. */
  hotkeys: ValidatorOperatorKey[];
  hotkey_count: number;
  primary_hotkey: string;
  coldkey: string | null;
  total_stake_tao: number;
  total_emission_tao: number;
  nominator_count: number | null;
  /** Sum of subnet memberships across the operator's validator hotkeys. */
  membership_count: number;
  uid_count: number;
  take_min: number | null;
  take_max: number | null;
  /** Stake-weighted across keys with a measured APY. */
  apy_estimate: number | null;
  stake_dominance: number | null;
}

export interface ValidatorOperatorDirectory {
  schema_version: 1;
  captured_at: string | null;
  block_number: number | null;
  validator_count: number;
  operator_count: number;
  operators: ValidatorOperatorEntry[];
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value: unknown): number {
  const number = finite(value);
  return number !== null && number >= 0 ? number : 0;
}

function nonNegativeInteger(value: unknown): number {
  const number = finite(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0
    ? number
    : 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function declaredIdentityName(validator: Row): string | null {
  const identity =
    validator.coldkey_identity &&
    typeof validator.coldkey_identity === "object" &&
    !Array.isArray(validator.coldkey_identity)
      ? (validator.coldkey_identity as Row)
      : null;
  if (identity?.has_identity !== true || typeof identity.name !== "string") {
    return null;
  }
  const name = identity.name.trim();
  return name.length > 0 ? name : null;
}

function hotkey(validator: Row): string | null {
  return nullableString(validator.hotkey);
}

function nullableCount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const count = finite(value);
  return count !== null && Number.isSafeInteger(count) && count >= 0
    ? count
    : null;
}

function ownershipBasis(
  validator: Row,
): NonNullable<ValidatorOperatorEntry["ownership_basis"]> {
  const count = nullableCount(validator.coldkey_count);
  if (count !== null && count > 1) return "ambiguous";
  return count === 1 && nullableString(validator.coldkey)?.trim()
    ? "single_coldkey"
    : "unknown";
}

/**
 * Group validator hotkeys into the same operator rows the site renders.
 *
 * The complete leaderboard reports distinct observed coldkeys per hotkey.
 * Only a single owner can establish shared membership; its declared name is
 * display metadata. Missing or conflicting ownership stays hotkey-scoped.
 * IDs are stable within this response's network, not global across networks.
 */
export function buildValidatorOperatorDirectory(
  globalValidators: Row | null | undefined,
): ValidatorOperatorDirectory {
  const validators = Array.isArray(globalValidators?.validators)
    ? (globalValidators.validators as Row[]).filter(
        (validator) => hotkey(validator) !== null,
      )
    : [];
  const grouped = new Map<string, Row[]>();
  for (const validator of validators) {
    const validatorHotkey = hotkey(validator)!;
    const groupKey =
      ownershipBasis(validator) === "single_coldkey"
        ? `coldkey:${validator.coldkey}`
        : `hotkey:${validatorHotkey}`;
    const group = grouped.get(groupKey);
    if (group) group.push(validator);
    else grouped.set(groupKey, [validator]);
  }

  const operators: ValidatorOperatorEntry[] = [];
  for (const [operatorId, unsorted] of grouped) {
    const keys = [...unsorted].sort(
      (a, b) =>
        nonNegative(b.total_stake_tao) - nonNegative(a.total_stake_tao) ||
        hotkey(a)!.localeCompare(hotkey(b)!),
    );
    const primary = keys[0]!;
    const identityName = declaredIdentityName(primary);
    const takes = keys
      .map((validator) => finite(validator.take))
      .filter((take): take is number => take !== null);
    const totalStake = keys.reduce(
      (sum, validator) => sum + nonNegative(validator.total_stake_tao),
      0,
    );
    let weightedApy = 0;
    let apyWeight = 0;
    for (const validator of keys) {
      const apy = finite(validator.apy_estimate);
      if (apy === null) continue;
      const stake = nonNegative(validator.total_stake_tao);
      weightedApy += apy * stake;
      apyWeight += stake;
    }

    const operatorKeys = keys.map((validator) => ({
      hotkey: hotkey(validator)!,
      total_stake_tao: nonNegative(validator.total_stake_tao),
      take: finite(validator.take),
    }));
    operators.push({
      operator_id: operatorId,
      ownership_basis: ownershipBasis(primary),
      identity_name: identityName,
      hotkeys: operatorKeys.length > 1 ? operatorKeys : [],
      hotkey_count: operatorKeys.length,
      primary_hotkey: hotkey(primary)!,
      coldkey: nullableString(primary.coldkey),
      total_stake_tao: totalStake,
      total_emission_tao: keys.reduce(
        (sum, validator) => sum + nonNegative(validator.total_emission_tao),
        0,
      ),
      // Per-hotkey counts cannot deduplicate the same account across keys.
      // Even complete counts cannot establish an operator-wide unique total;
      // missing members must not silently disappear from an aggregate either.
      nominator_count:
        keys.length === 1 ? nullableCount(primary.nominator_count) : null,
      membership_count: keys.reduce(
        (sum, validator) => sum + nonNegativeInteger(validator.subnet_count),
        0,
      ),
      uid_count: keys.reduce(
        (sum, validator) => sum + nonNegativeInteger(validator.uid_count),
        0,
      ),
      take_min: takes.length > 0 ? Math.min(...takes) : null,
      take_max: takes.length > 0 ? Math.max(...takes) : null,
      apy_estimate: apyWeight > 0 ? weightedApy / apyWeight : null,
      stake_dominance: null,
    });
  }

  operators.sort(
    (a, b) =>
      b.total_stake_tao - a.total_stake_tao ||
      a.primary_hotkey.localeCompare(b.primary_hotkey),
  );
  const listedStake = operators.reduce(
    (sum, operator) => sum + operator.total_stake_tao,
    0,
  );
  const ranked = operators.map((operator) => ({
    ...operator,
    stake_dominance:
      listedStake > 0 ? operator.total_stake_tao / listedStake : null,
  }));

  return {
    schema_version: 1,
    captured_at: nullableString(globalValidators?.captured_at),
    block_number:
      finite(globalValidators?.block_number) !== null
        ? nonNegativeInteger(globalValidators?.block_number)
        : null,
    validator_count: validators.length,
    operator_count: ranked.length,
    operators: ranked,
  };
}
