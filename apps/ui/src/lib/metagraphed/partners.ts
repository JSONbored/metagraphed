/**
 * Featured partner-validator configuration.
 *
 * Ventura Labs currently runs validators on the two adapter-backed pilot
 * subnets (Allways SN7, Gittensor SN74). White-label validators are rolling
 * out across the other application subnets -- add rows here as each hotkey
 * goes live and the delegation funnel automatically surfaces them in the
 * header CTA, `/delegate`, subnet mastheads, and the validator detail ribbon.
 *
 * Keep this file the single source of truth. UI code should never hard-code a
 * hotkey.
 */

export interface PartnerValidator {
  /** Subnet id this hotkey validates on. */
  netuid: number;
  /** Display name of the subnet, for UI labels that don't have subnet metadata handy. */
  subnetName: string;
  /**
   * SS58 hotkey of the Ventura-run validator on this subnet.
   *
   * TODO(ventura): replace the placeholder hotkeys below with the real
   * production hotkeys once they're published. Placeholders are clearly
   * marked and never treated as verified until swapped.
   */
  hotkey: string;
  /** Human label rendered in ribbons/cards. */
  label: string;
  /** Marketing one-liner shown in the delegate picker. */
  blurb: string;
  /**
   * When true, the row is fully live and the CTA can route straight to the
   * validator detail page. When false, the CTA renders as "coming soon" and
   * points to the subnet detail page instead — safe for white-label rollouts
   * that are announced before the hotkey is registered.
   */
  live: boolean;
}

export const PARTNER_ORG = {
  name: "Ventura Labs",
  slug: "ventura-labs",
  tagline: "Featured partner validator — running infrastructure across Bittensor.",
  disclosure:
    "Ventura Labs is a featured partner validator on Metagraphed. Metagraphed is unofficial and not endorsed by the OpenTensor Foundation.",
} as const;

export const PARTNER_VALIDATORS: PartnerValidator[] = [
  {
    netuid: 7,
    subnetName: "Allways",
    // Placeholder until Ventura publishes the production hotkey.
    hotkey: "5VenturaAllwaysHotkeyPlaceholder000000000000000000",
    label: "Ventura · Allways",
    blurb: "Adapter-backed pilot subnet. Live yield telemetry on /subnets/7.",
    live: false,
  },
  {
    netuid: 74,
    subnetName: "Gittensor",
    hotkey: "5VenturaGittensorHotkeyPlaceholder00000000000000000",
    label: "Ventura · Gittensor",
    blurb: "Adapter-backed pilot subnet. Live yield telemetry on /subnets/74.",
    live: false,
  },
];

/** Netuids Ventura runs on — cheap lookup for row-level "Delegate" affordances. */
export const PARTNER_NETUIDS: ReadonlySet<number> = new Set(
  PARTNER_VALIDATORS.map((p) => p.netuid),
);

export function partnerForNetuid(netuid: number | undefined | null): PartnerValidator | null {
  if (netuid == null) return null;
  return PARTNER_VALIDATORS.find((p) => p.netuid === netuid) ?? null;
}

export function isPartnerHotkey(hotkey: string | undefined | null): boolean {
  if (!hotkey) return false;
  return PARTNER_VALIDATORS.some((p) => p.hotkey === hotkey);
}
