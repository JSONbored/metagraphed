import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
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
    <div className="mg-compare-dock">
      <span>{label}</span>
      {chips.map((chip) => (
        <span key={chip.key} className="mg-compare-chip">
          {chip.text}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove ${chip.text} from compare`}
          >
            <X width={10} height={10} aria-hidden />
          </button>
        </span>
      ))}
      <span className="mg-compare-actions">
        <Link
          to={href}
          search={search}
          className="mg-compare-action"
          aria-disabled={ready ? undefined : true}
        >
          Compare
        </Link>
        <button type="button" onClick={onClear} className="mg-compare-action">
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
