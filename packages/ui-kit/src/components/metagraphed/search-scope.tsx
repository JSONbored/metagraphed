import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { classNames } from "@/lib/format";

export const SCOPES = [
  { key: "all", label: "All" },
  { key: "subnet", label: "Subnets" },
  { key: "surface", label: "Surfaces" },
  { key: "endpoint", label: "Endpoints" },
  { key: "provider", label: "Providers" },
  { key: "schema", label: "Schemas" },
] as const;

export type SearchScope = (typeof SCOPES)[number]["key"];

export function SearchScopeChip({
  value,
  onChange,
}: {
  value: SearchScope;
  onChange: (v: SearchScope) => void;
}) {
  const current = SCOPES.find((s) => s.key === value) ?? SCOPES[0];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Search scope: ${current.label}`}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-paper px-2.5 py-1 text-[11px] font-mono uppercase tracking-widest text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors shrink-0"
        >
          {current.label}
          <ChevronDown className="size-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        <ul>
          {SCOPES.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onChange(s.key)}
                className={classNames(
                  "w-full text-left px-2 py-1.5 rounded text-[12px] transition-colors",
                  s.key === value
                    ? "bg-surface text-ink-strong"
                    : "text-ink hover:bg-surface/60",
                )}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
