import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Sparkles, Coins } from "lucide-react";
import { partnerForNetuid, PARTNER_ORG } from "@/lib/metagraphed/partners";

interface Props {
  /**
   * When provided, the CTA is scoped to a single subnet. If the partner
   * (Ventura Labs) runs a validator on that subnet, this becomes the
   * branded "spotlight" delegation slot on the subnet page. Otherwise it
   * renders nothing.
   *
   * When omitted (homepage / global), it renders a neutral "Delegate & Earn"
   * link that points to the delegation funnel page. No partner branding.
   */
  netuid?: number;
  /** Visual density: `inline` = single line (masthead), `card` = padded block. */
  variant?: "inline" | "card";
  className?: string;
}

/**
 * Delegation call-to-action.
 *
 * - Homepage / global (no `netuid`): neutral "Delegate & Earn" — no partner
 *   name, no accent colors. Links to `/delegate`.
 * - Subnet page (with `netuid` that Ventura Labs runs on): branded spotlight
 *   CTA. Links to the partner validator's detail page (or the subnet page if
 *   the hotkey isn't live yet).
 * - Subnet page (with `netuid` that Ventura doesn't cover): renders nothing.
 */
export function DelegateCTA({ netuid, variant = "inline", className }: Props) {
  const partner = netuid != null ? partnerForNetuid(netuid) : null;
  if (netuid != null && !partner) return null;

  // Neutral (global) mode
  if (!partner) {
    if (variant === "card") {
      return (
        <Link
          to="/delegate"
          className={`mg-metric-tile group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-ink/30 ${className ?? ""}`}
        >
          <span
            aria-hidden
            className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-paper text-ink-strong"
          >
            <Coins className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-sm font-semibold text-ink-strong">
              Delegate & Earn
              <ArrowUpRight className="ml-1 inline size-3.5 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-muted">
              Stake τ to a validator across supported subnets
            </span>
          </span>
        </Link>
      );
    }
    return (
      <Link
        to="/delegate"
        className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card/50 text-sm font-medium text-ink hover:border-ink/30 hover:text-ink-strong transition-colors ${className ?? "px-3.5 py-1.5 text-[12px]"}`}
      >
        <Coins aria-hidden className="size-3.5" />
        Delegate & Earn
        <ArrowUpRight aria-hidden className="size-3" />
      </Link>
    );
  }

  // Branded spotlight mode — subnet page where Ventura runs a validator
  const href = partner.live
    ? { to: "/validators/$hotkey" as const, params: { hotkey: partner.hotkey } }
    : { to: "/subnets/$netuid" as const, params: { netuid: partner.netuid } };

  const label = `Delegate on ${partner.subnetName}`;
  const sub = partner.live
    ? `One-click stake · powered by ${PARTNER_ORG.name}`
    : `Coming soon — powered by ${PARTNER_ORG.name}`;

  if (variant === "card") {
    return (
      <Link
        {...href}
        className={`mg-metric-tile group flex items-start gap-3 rounded-xl border border-accent/50 bg-primary-soft/40 p-4 transition-colors hover:border-accent ${className ?? ""}`}
      >
        <span
          aria-hidden
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-accent/60 bg-paper text-accent"
        >
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-sm font-semibold text-ink-strong">
            {label}
            <ArrowUpRight className="ml-1 inline size-3.5 text-accent transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </span>
          <span className="mt-0.5 block text-[12px] text-ink-muted">{sub}</span>
        </span>
      </Link>
    );
  }

  return (
    <Link
      {...href}
      className={`inline-flex items-center gap-1.5 rounded-full border border-accent/60 bg-primary-soft/60 px-3.5 py-1.5 text-[12px] font-medium text-ink-strong transition-colors hover:border-accent hover:bg-primary-soft ${className ?? ""}`}
    >
      <Sparkles aria-hidden className="size-3 text-accent" />
      {label}
      <ArrowUpRight aria-hidden className="size-3" />
    </Link>
  );
}
