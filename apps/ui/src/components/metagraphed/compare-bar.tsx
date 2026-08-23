import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import { useCompareSelection } from "@/lib/metagraphed/compare-selection";
import { useValidatorsCompareSelection } from "@/lib/metagraphed/validators-compare-selection";
import { truncateSs58 } from "@/lib/metagraphed/resolve-address";

/**
 * The selection dock (#11611). It holds what you picked and links to
 * `/compare` — the comparison itself is a page with a URL you can send
 * someone, not a drawer that vanishes on navigation.
 */
function Dock({
  label,
  chips,
  href,
  search,
  onClear,
  ready,
}: {
  label: string;
  chips: Array<{ key: string; text: string; onRemove: () => void }>;
  href: "/compare";
  search: { subnets?: string; validators?: string };
  onClear: () => void;
  ready: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="mg-actions sticky bottom-3 z-[var(--mg-z-raised)] mt-3 flex flex-wrap items-center gap-2 rounded border border-rule bg-canvas px-3 py-2">
      <span className="text-11 text-ink-muted">{label}</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1 rounded border border-rule pl-2 pr-1 text-10 text-ink-strong"
        >
          {chip.text}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove ${chip.text} from compare`}
            className="inline-flex size-4 items-center justify-center rounded text-ink-muted hover:text-ink-strong"
          >
            <X className="size-2.5" aria-hidden />
          </button>
        </span>
      ))}
      <span className="ml-auto flex items-center gap-2">
        <Link
          to={href}
          search={search}
          className={classNames(
            "inline-flex h-7 items-center rounded border border-rule px-3 text-11",
            ready ? "text-ink-strong hover:border-rule-strong" : "pointer-events-none opacity-40",
          )}
          aria-disabled={ready ? undefined : true}
        >
          Compare
        </Link>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-7 items-center rounded border border-rule px-2.5 text-11 text-ink-muted hover:text-ink-strong"
        >
          Clear
        </button>
      </span>
    </div>
  );
}

export function SubnetCompareBar() {
  const { selected, remove, clear } = useCompareSelection();
  return (
    <Dock
      label="Compare"
      chips={selected.map((netuid) => ({
        key: String(netuid),
        text: `SN${netuid}`,
        onRemove: () => remove(netuid),
      }))}
      href="/compare"
      search={{ subnets: selected.slice(0, 3).join(",") }}
      onClear={clear}
      ready={selected.length >= 2}
    />
  );
}

export function ValidatorCompareBar() {
  const { selected, remove, clear } = useValidatorsCompareSelection();
  return (
    <Dock
      label="Compare"
      chips={selected.map((hotkey) => ({
        key: hotkey,
        text: truncateSs58(hotkey, 4),
        onRemove: () => remove(hotkey),
      }))}
      href="/compare"
      search={{ validators: selected.slice(0, 3).join(",") }}
      onClear={clear}
      ready={selected.length >= 2}
    />
  );
}
