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
  search: { kind?: "subnets" | "validators"; subnets?: string; validators?: string };
  onClear: () => void;
  ready: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="mg-compare-dock min-w-0 max-w-full">
      <span>{label}</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="mg-compare-chip min-w-0 max-w-full pointer-coarse:h-auto pointer-coarse:pr-0"
        >
          <span className="min-w-0 truncate" title={chip.text}>
            {chip.text}
          </span>
          <button
            type="button"
            className="shrink-0 pointer-coarse:h-11 pointer-coarse:w-11"
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
          className="mg-compare-action pointer-coarse:min-h-11"
          aria-disabled={ready ? undefined : true}
          tabIndex={ready ? 0 : -1}
          onClick={(event) => {
            if (!ready) event.preventDefault();
          }}
        >
          Compare
        </Link>
        <button
          type="button"
          onClick={onClear}
          className="mg-compare-action pointer-coarse:min-h-11"
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

export function ValidatorCompareBar({ names }: { names?: ReadonlyMap<string, string> }) {
  const { selected, remove, clear } = useValidatorsCompareSelection();
  return (
    <Dock
      label="Selected hotkeys"
      chips={selected.map((hotkey) => ({
        key: hotkey,
        text: `${truncateSs58(hotkey, 6)}${names?.get(hotkey) ? ` · ${names.get(hotkey)}` : ""}`,
        onRemove: () => remove(hotkey),
      }))}
      href="/compare"
      search={{ kind: "validators", validators: selected.join(",") }}
      onClear={clear}
      ready={selected.length >= 2}
    />
  );
}
