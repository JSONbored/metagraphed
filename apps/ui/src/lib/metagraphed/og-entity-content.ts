import { taoCompact } from "@/components/metagraphed/neuron-format";
import { shortHash } from "./blocks";
import { formatPct, formatTao } from "./format";
import { firstPartyLogoPath, logoHostFrom, type OgCardOptions } from "./og-card";

type Logo = string | { light?: string; dark?: string } | null;

function finiteAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Image copy is deliberately separate from SEO prose. These adapters consume
// existing loader projections; publication time does not imply current health.
export function subnetOgContent(
  netuid: number,
  data?: {
    name?: string | null;
    iconUrl?: Logo;
    website?: string | null;
    alphaPriceTao?: number | null;
    emissionShare?: number | null;
    totalStakeAlpha?: number | null;
  } | null,
): OgCardOptions {
  return {
    title: data?.name || `Subnet ${netuid}`,
    identifier: data?.name ? `Subnet ${netuid}` : null,
    subtitle: "Public interfaces, schemas and subnet economics.",
    logoPath: firstPartyLogoPath(data?.iconUrl),
    logoHost: logoHostFrom(data?.iconUrl, data?.website),
    stats: [
      ...(finiteAmount(data?.alphaPriceTao)
        ? [{ label: "Price", value: formatTao(data.alphaPriceTao) }]
        : []),
      ...(finiteAmount(data?.emissionShare)
        ? [{ label: "Emission", value: formatPct(data.emissionShare, 2) }]
        : []),
      ...(finiteAmount(data?.totalStakeAlpha)
        ? [{ label: "Alpha stake", value: `${taoCompact(data.totalStakeAlpha)} α` }]
        : []),
    ],
  };
}

export function validatorOgContent(
  hotkey: string,
  data?: {
    name?: string | null;
    logoPath?: string | null;
    logoHost?: string | null;
    subnetCount?: number | null;
  } | null,
): OgCardOptions {
  const label = shortHash(hotkey) ?? hotkey;
  return {
    title: data?.name || label,
    identifier: data?.name ? `Hotkey ${label}` : null,
    subtitle: "Declared validator identity and observed subnet memberships.",
    logoPath: data?.logoPath,
    logoHost: data?.logoHost,
    stats: count(data?.subnetCount)
      ? [{ label: "Subnets", value: String(data.subnetCount) }]
      : [],
  };
}

export function providerOgContent(
  slug: string,
  data?: {
    name?: string | null;
    iconUrl?: Logo;
    website?: string | null;
    endpoints?: number | null;
    surfaces?: number | null;
    subnets?: number | null;
  } | null,
): OgCardOptions {
  return {
    title: data?.name || slug,
    subtitle: "Registered endpoints, public interfaces and subnet coverage.",
    logoPath: firstPartyLogoPath(data?.iconUrl),
    logoHost: logoHostFrom(data?.iconUrl, data?.website),
    stats: [
      ...(count(data?.endpoints) ? [{ label: "Endpoints", value: String(data.endpoints) }] : []),
      ...(count(data?.surfaces) ? [{ label: "Surfaces", value: String(data.surfaces) }] : []),
      ...(count(data?.subnets) ? [{ label: "Subnets", value: String(data.subnets) }] : []),
    ],
  };
}

export function blockOgContent(ref: string, blockNumber?: number | null): OgCardOptions {
  const resolved = count(blockNumber) ? blockNumber : null;
  const reference = shortHash(ref) ?? ref;
  return {
    title: `Block ${resolved != null ? `#${blockNumber}` : reference}`,
    identifier: resolved != null && ref.startsWith("0x") ? reference : null,
    subtitle: "Extrinsics, events and timing for one Bittensor block.",
    entity: false,
  };
}

export function extrinsicOgContent(ref: string, call?: string | null): OgCardOptions {
  const name = call?.trim();
  const reference = shortHash(ref) ?? ref;
  const resolved = name && name !== "—" ? name : null;
  return {
    title: resolved ?? `Extrinsic ${reference}`,
    identifier: resolved ? `Extrinsic ${reference}` : null,
    subtitle: "Call data, signer, result and emitted events.",
    entity: false,
  };
}

export function eventOgContent(block: number, index: string, label?: string | null): OgCardOptions {
  return {
    title: label || `Event #${index}`,
    identifier: `Block #${block} · Event #${index}`,
    subtitle: "Decoded Bittensor event, arguments and originating extrinsic.",
    entity: false,
  };
}
