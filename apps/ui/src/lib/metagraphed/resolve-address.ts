// #8372: mirrors src/entity-labels.ts's resolveAddress/truncateSs58 (the
// Worker/backend copy) field-for-field, including the precedence comment --
// apps/ui never imports from the repo root's src/ (a real build boundary,
// same reason isValidSs58 above has its own copy rather than importing
// src/ss58.ts's decodeSs58). If either copy's precedence changes, change
// both; tests/entity-labels.test.ts and this file's own test pin the SAME
// behavior independently so a drift shows up as a real test failure, not a
// silent divergence.

export type ResolvedAddressSource = "private" | "identity" | "nametag" | "truncated";

export interface ResolvedAddress {
  display: string;
  source: ResolvedAddressSource;
  category: string | null;
  ss58: string;
}

export function truncateSs58(ss58: string, keep = 6): string {
  if (ss58.length <= keep * 2 + 1) return ss58;
  return `${ss58.slice(0, keep)}…${ss58.slice(-keep)}`;
}

export function resolveAddress(
  ss58: string,
  {
    localLabel,
    identityName,
    nametag,
    keep,
  }: {
    localLabel?: string | null;
    identityName?: string | null;
    nametag?: { name?: unknown; category?: unknown } | null;
    keep?: number;
  } = {},
): ResolvedAddress {
  const priv = typeof localLabel === "string" ? localLabel.trim() : "";
  if (priv) {
    return { display: priv, source: "private", category: null, ss58 };
  }
  const identity = typeof identityName === "string" ? identityName.trim() : "";
  if (identity) {
    return { display: identity, source: "identity", category: null, ss58 };
  }
  const tagName = typeof nametag?.name === "string" ? nametag.name.trim() : "";
  if (tagName) {
    return {
      display: tagName,
      source: "nametag",
      category: typeof nametag?.category === "string" && nametag.category ? nametag.category : null,
      ss58,
    };
  }
  return { display: truncateSs58(ss58, keep), source: "truncated", category: null, ss58 };
}
