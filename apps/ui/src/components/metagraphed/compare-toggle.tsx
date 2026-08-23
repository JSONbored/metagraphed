import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { useCompareSelection } from "@/lib/metagraphed/compare-selection";
import { useValidatorsCompareSelection } from "@/lib/metagraphed/validators-compare-selection";

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
      className={classNames(
        "inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        on ? "bg-accent border-accent text-paper" : "border-border bg-paper hover:border-accent/60",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {on ? (
        <svg viewBox="0 0 12 12" fill="none" className="size-2.5" aria-hidden>
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

export function ValidatorCompareToggle({ hotkey }: { hotkey: string }) {
  const { has, toggle, selected, max } = useValidatorsCompareSelection();
  const on = has(hotkey);
  const disabled = !on && selected.length >= max;
  const short = shortHash(hotkey) ?? hotkey;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Remove ${short} from compare` : `Add ${short} to compare`}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) toggle(hotkey);
      }}
      title={disabled ? `Compare is full (${max})` : on ? "Remove from compare" : "Add to compare"}
      className={classNames(
        "inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        on ? "bg-accent border-accent text-paper" : "border-border bg-paper hover:border-accent/60",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {on ? (
        <svg viewBox="0 0 12 12" fill="none" className="size-2.5" aria-hidden>
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
