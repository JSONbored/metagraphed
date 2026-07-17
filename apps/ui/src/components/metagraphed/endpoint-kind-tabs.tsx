import { classNames } from "@/lib/metagraphed/format";
import { CATEGORY_LABEL, type EndpointCategory } from "@/lib/metagraphed/endpoint-pool";
import { rovingTabIndex, useRovingTablist } from "@/hooks/use-roving-tablist";

interface Props {
  value: EndpointCategory | "all";
  counts: Partial<Record<EndpointCategory | "all", number>>;
  onChange: (v: EndpointCategory | "all") => void;
}

const ORDER: Array<EndpointCategory | "all"> = ["all", "rpc", "wss", "api", "sse", "data", "other"];

export function EndpointKindTabs({ value, counts, onChange }: Props) {
  // #6391: only "all" plus non-empty categories render, so roving-tabindex nav
  // walks the actually-visible tabs (not the full ORDER).
  const visible = ORDER.filter((k) => k === "all" || (counts[k] ?? 0) > 0);
  const activeIndex = Math.max(0, visible.indexOf(value));
  const { tabRef, onKeyDown } = useRovingTablist(visible.length, (i) => onChange(visible[i]));

  return (
    <div
      role="tablist"
      aria-label="Filter endpoints by kind"
      className="flex flex-wrap items-center gap-1.5"
    >
      {visible.map((k, i) => {
        const active = value === k;
        const label = k === "all" ? "All" : CATEGORY_LABEL[k];
        const count = counts[k];
        return (
          <button
            key={k}
            ref={tabRef(i)}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={rovingTabIndex(i, activeIndex)}
            onClick={() => onChange(k)}
            onKeyDown={onKeyDown(i)}
            className={classNames(
              // !rounded-full overrides mg-focus-ring's hardcoded 6px ring radius.
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors mg-focus-ring !rounded-full",
              active
                ? "border-accent/60 bg-accent/15 text-ink-strong"
                : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-ink/30",
            )}
          >
            {label}
            {count != null ? (
              <span
                className={classNames(
                  "rounded-sm px-1 tabular-nums text-[10px]",
                  active ? "bg-paper/40 text-ink-strong" : "bg-surface/60 text-ink-muted",
                )}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
