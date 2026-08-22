import { Definition } from "./interaction/definition";
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
 * Pool-eligibility chip; the chip is the `Definition` trigger for its rule.
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
    <Definition
      term={ELIGIBILITY_LABEL[eligibility]}
      sentence={RULE[eligibility]}
    >
      <span
        className={classNames(
          "inline-flex items-center gap-1.5 rounded border bg-transparent whitespace-nowrap transition-colors",
          "mg-dot-before",
          "hover:bg-surface",
          size === "xs" ? "px-2 py-0 h-5 text-11" : "px-2.5 py-0 h-6 text-11",
          TONE[eligibility],
        )}
      >
        {ELIGIBILITY_LABEL[eligibility]}
      </span>
    </Definition>
  );
}
