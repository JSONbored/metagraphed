import { useCompareSelection } from "@/lib/metagraphed/compare-selection";

/**
 * The per-row compare checkboxes (#11611). Selection lives in localStorage so
 * it survives navigation; `CompareBar` turns it into a link to /compare.
 */
export function CompareToggle({ netuid }: { netuid: number }) {
  const { has, toggle, selected, max } = useCompareSelection();
  const on = has(netuid);
  const disabled = !on && selected.length >= max;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Remove SN${netuid} from compare` : `Add SN${netuid} to compare`}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) toggle(netuid);
      }}
      title={disabled ? `Compare is full (${max})` : on ? "Remove from compare" : "Add to compare"}
      className="mg-compare-toggle mg-tap-target"
    >
      {on ? (
        <svg viewBox="0 0 12 12" fill="none" width="10" height="10" aria-hidden>
          <path
            d="M2 6.5l2.5 2.5L10 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}
