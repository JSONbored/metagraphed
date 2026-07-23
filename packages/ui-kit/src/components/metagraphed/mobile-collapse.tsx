import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { classNames } from "@/lib/format";

export interface MobileCollapseProps {
  /**
   * Short label shown as the mobile disclosure trigger. Should match the
   * SectionAnchor title above so users know what they're expanding.
   */
  label: string;
  /** Optional one-line hint under the label while collapsed. */
  hint?: string;
  /** Optional micro-count / status chip rendered on the trigger's right. */
  trailing?: ReactNode;
  /**
   * Whether the panel starts expanded on mobile. Defaults to false so
   * secondary panels sit collapsed by default — the whole point of the
   * progressive-disclosure sweep on /subnets/:netuid.
   */
  defaultOpen?: boolean;
  /** Content shown when expanded (mobile) or always (>= md). */
  children: ReactNode;
  className?: string;
}

/**
 * Mobile-first progressive disclosure wrapper. Below `md:` the children are
 * collapsed behind a hairline trigger row; from `md:` up the children render
 * normally and the trigger is hidden. Keeps every panel deep-linkable via its
 * parent SectionAnchor id — the disclosure only affects visual weight, not
 * routing.
 */
export function MobileCollapse({
  label,
  hint,
  trailing,
  defaultOpen = false,
  children,
  className,
}: MobileCollapseProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={className}>
      {/* Mobile-only trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={classNames(
          "md:hidden w-full flex items-center justify-between gap-3",
          "rounded border border-border bg-card px-3 py-2 mg-focus-ring",
          "text-left transition-colors hover:border-accent/40",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="mg-type-micro text-ink-strong">{label}</span>
          {hint ? (
            <span className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
              {hint}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {trailing}
          <ChevronDown
            aria-hidden
            className={classNames(
              "size-4 text-ink-muted transition-transform",
              open ? "rotate-180" : "rotate-0",
            )}
          />
        </span>
      </button>

      {/* Content: hidden on mobile when collapsed, always visible md+ */}
      <div
        className={classNames(
          open ? "mt-3 block" : "hidden",
          "md:mt-0 md:block",
        )}
      >
        {children}
      </div>
    </div>
  );
}
