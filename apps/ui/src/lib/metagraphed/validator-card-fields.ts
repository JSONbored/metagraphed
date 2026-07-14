import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { GlobalValidator } from "@/lib/metagraphed/types";

/**
 * Display strings a validator card derives from a `GlobalValidator` row. Kept
 * pure (no JSX, no component imports) so the null-handling branches are
 * unit-tested apart from the DOM. Stake/emission stay in the component since
 * they format via `taoCompact`.
 */
export interface ValidatorCardFields {
  /** Shortened hotkey, falling back to the full key when too short to shorten. */
  hotkeyShort: string;
  /** Shortened coldkey, or null when the row has no coldkey. */
  coldkeyShort: string | null;
  subnetsLabel: string;
  uidsLabel: string;
  /** Nominator count, or an em dash when the low-frequency source has no row. */
  nominatorsLabel: string;
  /** Stake dominance as a 2-dp percentage, or an em dash when null. */
  dominanceLabel: string;
  /** Estimated APY as a 1-dp percentage, or an em dash when null. */
  apyLabel: string;
}

/**
 * Resolve the labelled fields a validator card renders. Labels track the
 * underlying data field (not table column position), so the cards read
 * correctly regardless of the table's header layout.
 */
export function resolveValidatorCard(v: GlobalValidator): ValidatorCardFields {
  return {
    hotkeyShort: shortHash(v.hotkey) ?? v.hotkey,
    coldkeyShort: v.coldkey ? (shortHash(v.coldkey) ?? v.coldkey) : null,
    subnetsLabel: formatNumber(v.subnet_count),
    uidsLabel: formatNumber(v.uid_count),
    nominatorsLabel: v.nominator_count != null ? formatNumber(v.nominator_count) : "—",
    dominanceLabel: v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—",
    apyLabel: v.apy_estimate != null ? `${(v.apy_estimate * 100).toFixed(1)}%` : "—",
  };
}
