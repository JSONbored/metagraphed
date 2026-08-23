/**
 * The derivations behind /accounts (#11615).
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type { AccountListEntry, ChainSignerEntry } from "@/lib/metagraphed/types";

export type HolderMetric = "stake" | "emission" | "reach";

/**
 * The metric names map onto the sorts `/api/v1/accounts` accepts, which are
 * `total_stake | total_emission | subnet_count | uid_count` and nothing else
 * (anything further is a 400). "Reach" is `subnet_count`: how many subnets an
 * account has a position in, which is a different question from how much it
 * holds and the one a concentration page should also be able to ask.
 */
export const HOLDER_SORT: Record<HolderMetric, string> = {
  stake: "total_stake",
  emission: "total_emission",
  reach: "subnet_count",
};

export const HOLDER_METRICS = [
  { value: "stake", label: "Stake" },
  { value: "emission", label: "Emission" },
  { value: "reach", label: "Reach" },
] as const;

/** "1 subnet", "7 subnets" -- a card that says "1 subnets" reads as a bug. */
export const plural = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

export const shortAddress = (address: string): string =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const fmtTaoCompact = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M τ`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k τ`;
  return `${value.toFixed(2)} τ`;
};

export interface HolderCard {
  key: string;
  name: string;
  sub: string;
  value: string;
  href: string;
}

/** The reading each metric puts on a card, so the card shows what it ranked by. */
export function holderCards(
  accounts: readonly AccountListEntry[],
  metric: HolderMetric,
  limit = 18,
): HolderCard[] {
  return accounts.slice(0, limit).flatMap((account) => {
    const address = account.coldkey ?? account.hotkey;
    if (!address) return [];
    const value =
      metric === "stake"
        ? fmtTaoCompact(account.total_stake_tao)
        : metric === "emission"
          ? fmtTaoCompact(account.total_emission_tao)
          : plural(account.subnet_count ?? 0, "subnet");
    return [
      {
        key: address,
        name: shortAddress(address),
        sub: `${plural(account.subnet_count ?? 0, "subnet")} · ${plural(account.uid_count ?? 0, "UID")}`,
        value,
        href: `/accounts/${address}`,
      },
    ];
  });
}

export interface ConcentrationSegment {
  key: string;
  label: string;
  value: number;
  href?: string;
}

/**
 * The listed accounts as shares of the stake they collectively hold.
 *
 * NOT of the network: `/api/v1/accounts` serves a top-N slice, so the
 * denominator here is the slice's own total and the caller must say so. A
 * share of "all stake" computed from a top-20 read would overstate every
 * segment by the whole tail.
 */
export function concentrationSegments(
  accounts: readonly AccountListEntry[],
  top = 10,
): { segments: ConcentrationSegment[]; listedTotal: number } {
  const rows = accounts
    .map((account) => ({
      address: account.coldkey ?? account.hotkey ?? "",
      stake: typeof account.total_stake_tao === "number" ? account.total_stake_tao : 0,
    }))
    .filter((row) => row.address !== "" && row.stake > 0)
    .sort((a, b) => b.stake - a.stake);

  const listedTotal = rows.reduce((acc, row) => acc + row.stake, 0);
  const head = rows.slice(0, top);
  const tail = rows.slice(top);
  const segments: ConcentrationSegment[] = head.map((row) => ({
    key: row.address,
    label: shortAddress(row.address),
    value: row.stake,
    href: `/accounts/${row.address}`,
  }));
  if (tail.length > 0) {
    segments.push({
      key: RESIDUAL_KEY,
      label: `${tail.length} more listed`,
      value: tail.reduce((acc, row) => acc + row.stake, 0),
    });
  }
  return { segments, listedTotal };
}

export interface ActiveRow {
  signer: string;
  tx_count: number;
  last_tx_block: number | null;
}

/** Signers ranked by transactions in the window, busiest first. */
export function activeRows(signers: readonly ChainSignerEntry[]): ActiveRow[] {
  return signers
    .filter((signer) => Boolean(signer.signer) && (signer.tx_count ?? 0) > 0)
    .map((signer) => ({
      signer: signer.signer,
      tx_count: signer.tx_count ?? 0,
      last_tx_block: signer.last_tx_block ?? null,
    }))
    .sort((a, b) => b.tx_count - a.tx_count);
}

export type LookupVerdict =
  | { kind: "empty" }
  | { kind: "ss58"; path: string }
  | { kind: "h160"; search: { h160: string } }
  | { kind: "invalid"; message: string };

/**
 * What the lookup field should do with what was typed.
 *
 * Pure so the "rejects invalid input inline" behaviour is testable without a
 * DOM, and so the field has exactly one place that decides — the previous
 * page decided in three (an effect, a submit handler and a paste handler).
 */
export function lookupVerdict(
  raw: string,
  isSs58: (value: string) => boolean,
  isH160: (value: string) => boolean,
  normalizeH160: (value: string) => string,
): LookupVerdict {
  const value = raw.trim();
  if (value === "") return { kind: "empty" };
  if (isSs58(value)) return { kind: "ss58", path: value };
  if (isH160(value)) return { kind: "h160", search: { h160: normalizeH160(value) } };
  return {
    kind: "invalid",
    message: value.startsWith("0x")
      ? "That is not a valid EVM address — 0x followed by 40 hex characters."
      : "That is not a valid ss58 address or EVM address.",
  };
}
