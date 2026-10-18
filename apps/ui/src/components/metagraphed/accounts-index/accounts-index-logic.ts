/**
 * The derivations behind /accounts (#11615).
 */
import type { AccountHolderDirectoryEntry, ChainSignerEntry } from "@/lib/metagraphed/types";
import { formatAmount } from "@/lib/metagraphed/format";

export type HolderMetric = "reach" | "emission";

/**
 * These independent rankings describe registered hotkeys. Neuron voting
 * weight does not establish capital, so stake is not a supported metric.
 */
export const HOLDER_SORT: Record<HolderMetric, string> = {
  reach: "subnet_count",
  emission: "total_emission",
};

export const HOLDER_METRICS = [
  { value: "reach", label: "Reach" },
  { value: "emission", label: "Emission" },
] as const;

/** "1 subnet", "7 subnets" -- a card that says "1 subnets" reads as a bug. */
export const plural = (count: number | null, singular: string, plural = `${singular}s`): string =>
  `${count ?? "—"} ${count === 1 ? singular : plural}`;

export const shortAddress = (address: string): string =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const fmtTaoCompact = (value: number | null | undefined): string => formatAmount(value, "τ");

export interface HolderCard {
  key: string;
  name: string;
  sub: string;
  value: string;
  href: string;
}

/** Preserve the selected server ranking; never derive it from another bounded list. */
export function holderCards(
  accounts: readonly AccountHolderDirectoryEntry[],
  metric: HolderMetric,
  limit = 18,
): HolderCard[] {
  // Also refuse an obsolete runtime metric when old state bypasses TypeScript.
  if (metric !== "reach" && metric !== "emission") return [];
  return accounts.slice(0, limit).flatMap((account) => {
    const address = account.hotkey;
    if (!address) return [];
    const value =
      metric === "emission"
        ? fmtTaoCompact(account.total_emission_tao)
        : plural(account.subnet_count, "subnet");
    return [
      {
        key: address,
        name: shortAddress(address),
        sub: `${plural(account.subnet_count, "subnet")} · ${plural(account.uid_count, "UID")}`,
        value,
        href: `/accounts/${address}`,
      },
    ];
  });
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
