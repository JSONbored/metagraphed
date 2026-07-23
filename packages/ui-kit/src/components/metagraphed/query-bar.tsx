import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import { ChevronDown, Search, X, Check } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { classNames } from "@/lib/format";

/**
 * QueryBar — a single hairline "command surface" that hosts the search
 * input, filter triggers, and utility controls for a data list route.
 *
 * Composition (all pieces optional, use what fits):
 *
 *   <QueryBar>
 *     <QueryBar.Search value={q} onChange={setQ} placeholder="Search…" />
 *     <QueryBar.Divider />
 *     <QueryBar.FilterTrigger label="Health" options={[…]} value={h} onChange={setH} />
 *     <QueryBar.FilterTrigger label="Curation" options={[…]} value={c} onChange={setC} />
 *     <QueryBar.Divider />
 *     <QueryBar.Utility>{utilityControls}</QueryBar.Utility>
 *   </QueryBar>
 *   <QueryBar.MetaRow count={128} total={128} onReset={…} activeCount={n} />
 *
 * Focus-within on the shell lights a single accent border so the whole
 * bar feels like one control rather than a bag of chips.
 */

export interface QueryBarProps {
  children: ReactNode;
  className?: string;
  /** Accessible label for the surrounding <form>. */
  ariaLabel?: string;
}

function QueryBarRoot({
  children,
  className,
  ariaLabel = "Filter bar",
}: QueryBarProps) {
  return (
    <div
      role="search"
      aria-label={ariaLabel}
      className={classNames(
        "mg-query-shell",
        "flex w-full items-center gap-1 min-w-0",
        "h-10 rounded-lg border border-border bg-card/60",
        "px-1 transition-colors",
        "focus-within:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
        "focus-within:ring-2 focus-within:ring-ring/60",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Search                                                                     */
/* -------------------------------------------------------------------------- */

export interface QueryBarSearchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value"
> {
  value: string;
  onChange: (v: string) => void;
  /** Bind `/` to focus this input from anywhere on the route. */
  shortcut?: boolean;
  /**
   * Debounce commits to `onChange` by this many ms. The input stays
   * responsive (local state updates every keystroke) so typing never
   * feels laggy — only the URL/filter sync is throttled. Default 0.
   */
  debounceMs?: number;
}

function QueryBarSearch({
  value,
  onChange,
  placeholder = "Search…",
  shortcut = true,
  debounceMs = 0,
  className,
  ...props
}: QueryBarSearchProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Local mirror keeps typing responsive when a caller debounces commits.
  const [local, setLocal] = useState(value);
  // Sync when parent value changes externally (URL replace, reset, etc.)
  // and the input isn't the source of the current pending commit.
  useEffect(() => {
    setLocal(value);
  }, [value]);
  // Commit debounced.
  useEffect(() => {
    if (local === value) return;
    if (debounceMs <= 0) {
      onChange(local);
      return;
    }
    const t = window.setTimeout(() => onChange(local), debounceMs);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, debounceMs]);

  useEffect(() => {
    if (!shortcut || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable)
        return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  return (
    <div className="relative flex flex-1 items-center gap-2 min-w-0 pl-2">
      <Search className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
      <input
        {...props}
        ref={ref}
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && debounceMs > 0 && local !== value) {
            onChange(local);
          }
          if (e.key === "Escape" && local) {
            e.preventDefault();
            setLocal("");
            onChange("");
          }
          props.onKeyDown?.(e);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className={classNames(
          "peer flex-1 min-w-0 bg-transparent border-0 outline-none",
          "py-1.5 text-[13px] text-ink-strong placeholder:text-ink-subtle-text",
          "focus:outline-none focus:ring-0",
          className,
        )}
      />
      {local ? (
        <button
          type="button"
          onClick={() => {
            setLocal("");
            onChange("");
            ref.current?.focus();
          }}
          aria-label="Clear search"
          className="mg-focus-ring inline-flex size-6 items-center justify-center rounded text-ink-muted hover:text-ink-strong"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : shortcut ? (
        <kbd
          aria-hidden
          className="pointer-events-none hidden sm:inline-flex items-center rounded border border-border/70 bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
        >
          /
        </kbd>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Divider                                                                    */
/* -------------------------------------------------------------------------- */

function QueryBarDivider() {
  return (
    <span
      aria-hidden
      className="mx-0.5 hidden sm:block h-5 w-px shrink-0 bg-border"
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Utility slot (icon-only trailing cluster)                                 */
/* -------------------------------------------------------------------------- */

function QueryBarUtility({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        "flex items-center gap-0.5 shrink-0 pr-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  FilterTrigger — ghost button + Radix popover with cmdk typeahead          */
/* -------------------------------------------------------------------------- */

export interface QueryBarFilterOption {
  value: string;
  label: string;
  /** Optional keywords the typeahead should match against (in addition to label). */
  keywords?: string[];
}

type SingleProps = {
  multi?: false;
  value: string;
  onChange: (v: string) => void;
};

type MultiProps = {
  multi: true;
  value: string[];
  onChange: (v: string[]) => void;
};

export type QueryBarFilterTriggerProps = {
  /** Label shown before the value, e.g. "Health". */
  label: string;
  options: QueryBarFilterOption[];
  /** Placeholder shown when nothing is selected (default "Any"). */
  placeholder?: string;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
  /** Popover align — matches Radix defaults. */
  align?: "start" | "center" | "end";
  className?: string;
} & (SingleProps | MultiProps);

function QueryBarFilterTrigger(props: QueryBarFilterTriggerProps) {
  const {
    label,
    options,
    placeholder = "Any",
    icon,
    align = "start",
    className,
  } = props;
  const id = useId();
  const [open, setOpen] = useState(false);

  const selected: string[] = props.multi
    ? props.value
    : props.value
      ? [props.value]
      : [];
  const active = selected.length > 0;

  const preview = useMemo(() => {
    if (!active) return placeholder;
    const labels = selected.map(
      (v) => options.find((o) => o.value === v)?.label ?? v,
    );
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
  }, [selected, options, active, placeholder]);

  const toggle = useCallback(
    (v: string) => {
      if (props.multi) {
        const next = selected.includes(v)
          ? selected.filter((s) => s !== v)
          : [...selected, v];
        props.onChange(next);
      } else {
        props.onChange(selected[0] === v ? "" : v);
        setOpen(false);
      }
    },
    [props, selected],
  );

  const clear = useCallback(() => {
    if (props.multi) props.onChange([]);
    else props.onChange("");
  }, [props]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={`${label} filter${active ? `, ${selected.length} selected` : ""}`}
          className={classNames(
            "mg-ghost-trigger group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2",
            "text-[12px] transition-colors",
            "hover:bg-surface-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active ? "text-ink-strong" : "text-ink-muted",
            className,
          )}
        >
          {icon ? (
            <span className="shrink-0 text-ink-muted">{icon}</span>
          ) : null}
          <span className="mg-type-micro opacity-80">{label}</span>
          <span
            className={classNames(
              "truncate max-w-[120px] font-medium",
              active
                ? "text-ink-strong border-b border-accent"
                : "text-ink-subtle-text",
            )}
          >
            {preview}
          </span>
          <ChevronDown
            className={classNames(
              "size-3 shrink-0 text-ink-muted transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-64 p-0 border-border bg-popover"
      >
        <Command>
          <CommandInput
            placeholder={`Filter ${label.toLowerCase()}…`}
            className="h-9"
          />
          <CommandList className="max-h-72">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <CommandItem
                    key={o.value}
                    value={o.label}
                    {...(o.keywords ? { keywords: o.keywords } : {})}
                    onSelect={() => toggle(o.value)}
                    className="cursor-pointer aria-selected:bg-surface-2"
                  >
                    <span
                      className={classNames(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                        on
                          ? "border-accent bg-accent text-accent-foreground"
                          : "border-border bg-transparent",
                      )}
                      aria-hidden
                    >
                      {on ? <Check className="size-3" /> : null}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          {active ? (
            <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
              <span className="mg-type-micro text-ink-muted">
                {selected.length} selected
              </span>
              <button
                type="button"
                onClick={() => {
                  clear();
                  if (!props.multi) setOpen(false);
                }}
                className="mg-focus-ring rounded px-2 py-0.5 mg-type-micro text-ink-muted hover:text-ink-strong"
              >
                Clear
              </button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------------------- */
/*  MetaRow — below-the-bar micro line                                        */
/* -------------------------------------------------------------------------- */

export interface QueryBarMetaRowProps {
  /** Visible / filtered count. */
  count: number;
  /** Total unfiltered count. */
  total?: number;
  /** Noun for the count (e.g. "subnets"). */
  noun?: string;
  /** Active filter count. Renders "· N filters" + reset. */
  activeCount?: number;
  onReset?: () => void;
  /** Right-aligned slot for extras (e.g. freshness pill). */
  trailing?: ReactNode;
  className?: string;
}

function QueryBarMetaRow({
  count,
  total,
  noun = "results",
  activeCount = 0,
  onReset,
  trailing,
  className,
}: QueryBarMetaRowProps) {
  const showTotal = total != null && total !== count;
  return (
    <div
      className={classNames(
        "flex w-full items-center gap-2 pt-1.5",
        "mg-type-micro text-ink-muted",
        className,
      )}
    >
      <span aria-live="polite">
        <span className="text-ink-strong">{count.toLocaleString()}</span>
        {showTotal ? (
          <span className="opacity-70"> of {total!.toLocaleString()}</span>
        ) : null}{" "}
        {noun}
      </span>
      {activeCount > 0 ? (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span>
            {activeCount} filter{activeCount === 1 ? "" : "s"}
          </span>
          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              className="mg-focus-ring rounded text-accent hover:text-ink-strong transition-colors"
            >
              Reset
            </button>
          ) : null}
        </>
      ) : null}
      {trailing ? (
        <span className="ml-auto flex items-center gap-2">{trailing}</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Compound export                                                            */
/* -------------------------------------------------------------------------- */

interface QueryBarContextValue {
  /* reserved for future coordination (e.g. shared focus routing) */
  __v: 1;
}
const _ctx = createContext<QueryBarContextValue | null>(null);
export function useQueryBarContext() {
  return useContext(_ctx);
}

export const QueryBar = Object.assign(QueryBarRoot, {
  Search: QueryBarSearch,
  Divider: QueryBarDivider,
  Utility: QueryBarUtility,
  FilterTrigger: QueryBarFilterTrigger,
  MetaRow: QueryBarMetaRow,
});
