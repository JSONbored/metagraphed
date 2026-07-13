import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { classNames } from "@/lib/format";

// Duplicated from apps/ui/src/lib/metagraphed/endpoint-pool.ts -- both are
// self-contained (no further deps); the function that actually derives a
// PoolEligibility from an Endpoint stays app-side, this component only ever
// receives an already-computed value.
export type PoolEligibility =
  "proxy-enabled" | "pool-member" | "archive-capable" | "unassigned";

const ELIGIBILITY_LABEL: Record<PoolEligibility, string> = {
  "proxy-enabled": "Proxy",
  "pool-member": "Pool",
  "archive-capable": "Archive",
  unassigned: "Unassigned",
};

const TONE: Record<PoolEligibility, string> = {
  "proxy-enabled": "border-accent/50 text-curation-pilot before:bg-accent",
  "pool-member":
    "border-curation-machine/50 text-curation-machine before:bg-curation-machine",
  "archive-capable":
    "border-curation-verified/50 text-curation-verified before:bg-curation-verified",
  unassigned: "border-border text-ink-muted before:bg-ink-subtle",
};

const RULE: Record<PoolEligibility, string> = {
  "proxy-enabled":
    "Routable through the Metagraphed pool when proxy is enabled backend-side. Routing remains future-scoped.",
  "pool-member":
    "Curated member of an RPC pool — eligible for routing once proxy is enabled.",
  "archive-capable":
    "Historical block data supported — suitable for archival reads beyond head depth.",
  unassigned:
    "Not assigned to any pool yet. Eligible for pooling once verification metadata is added.",
};

/**
 * Pool-eligibility chip with shadcn tooltip explaining the rule.
 * Outline + leading dot. Active hover state surfaces the accent border.
 */
export function EligibilityChip({
  eligibility,
  size = "sm",
}: {
  eligibility: PoolEligibility;
  size?: "sm" | "xs";
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* #3433: tabIndex is what makes this trigger keyboard-operable at
              all -- Radix only opens the Tooltip on a focus event, and a
              plain span never receives one without it. Verified via a
              scripted focus/Escape check: focus opens the tooltip
              (data-state instant-open) and Escape closes it while keeping
              focus on the trigger, with no extra wiring needed beyond
              this attribute. This is the reference HeaderHint
              (endpoint-list.tsx) now matches -- don't drop it. */}
          <span
            tabIndex={0}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded-full border bg-transparent font-mono uppercase tracking-wider whitespace-nowrap cursor-help transition-colors",
              "before:content-[''] before:size-1.5 before:rounded-full",
              "hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "xs"
                ? "px-2 py-0 text-[9px] h-5"
                : "px-2.5 py-0 text-[10px] h-6",
              TONE[eligibility],
            )}
          >
            {ELIGIBILITY_LABEL[eligibility]}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[240px] text-[11px] leading-relaxed"
        >
          <div className="font-mono uppercase tracking-widest text-[9px] opacity-70 mb-1">
            {ELIGIBILITY_LABEL[eligibility]}
          </div>
          {RULE[eligibility]}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
