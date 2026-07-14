import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { EntityHoverCard } from "./entity-hover-card";
import { MEGA_MENU_HOVER_DEFAULTS } from "./entity-hover-placement";

/**
 * Live mega-menu row wrapped in EntityHoverCard (#5337).
 *
 * Subnet/provider preview cards previously used a raw Radix HoverCard with no
 * touch guard. Routing through EntityHoverCard applies the shared
 * `(hover: none), (pointer: coarse)` passthrough so touch-primary tablets get
 * a single-tap link instead of a stuck hover state.
 */
export type MegaMenuLivePreviewItem = {
  kind: "subnet" | "provider";
  to: string;
  params: Record<string, string>;
  label: string;
  sub: string;
  previewId: number | string;
};

type MegaMenuLivePreviewLinkProps = {
  item: MegaMenuLivePreviewItem;
  onNavigate?: () => void;
  registerItem: (el: HTMLAnchorElement | null, index: number) => void;
  itemIndex: number;
};

const LIVE_LINK_CLASS =
  "flex items-center justify-between rounded-md px-2 py-1.5 -mx-2 hover:bg-surface/70 focus:bg-surface/70 focus:outline-none transition-colors";

function LiveRowLink({ item, onNavigate, registerItem, itemIndex }: MegaMenuLivePreviewLinkProps) {
  return (
    <Link
      to={item.to}
      params={item.params as never}
      onClick={onNavigate}
      ref={(el) => registerItem(el, itemIndex)}
      className={LIVE_LINK_CLASS}
      preload="intent"
      data-mega-live-preview={item.kind}
    >
      <span className="min-w-0">
        <span className="block text-sm text-ink-strong truncate">{item.label}</span>
        <span className="block text-[11px] text-ink-muted truncate">{item.sub}</span>
      </span>
      <ArrowUpRight className="size-3 text-ink-muted shrink-0" />
    </Link>
  );
}

export function MegaMenuLivePreviewLink(props: MegaMenuLivePreviewLinkProps): ReactNode {
  const { item } = props;
  if (item.kind === "subnet") {
    return (
      <EntityHoverCard
        kind="subnet"
        netuid={item.previewId as number}
        {...MEGA_MENU_HOVER_DEFAULTS}
      >
        <LiveRowLink {...props} />
      </EntityHoverCard>
    );
  }
  return (
    <EntityHoverCard kind="provider" slug={item.previewId as string} {...MEGA_MENU_HOVER_DEFAULTS}>
      <LiveRowLink {...props} />
    </EntityHoverCard>
  );
}
