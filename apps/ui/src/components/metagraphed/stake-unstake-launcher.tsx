import { forwardRef, lazy, Suspense, useCallback, useRef, useState } from "react";
import type { StakeUnstakeModalProps } from "./stake-unstake-modal";

// The chain client and wallet flow are relevant only after a reader explicitly
// chooses to delegate. Keeping this launcher in the detail route preserves the
// immediately-visible action while letting the full signing surface load only
// on intent (and warm on pointer/focus intent before the click).
const loadStakeUnstakeModal = () => import("./stake-unstake-modal");
const StakeUnstakeModal = lazy(async () => {
  const module = await loadStakeUnstakeModal();
  return { default: module.StakeUnstakeModal };
});

type StakeUnstakeLauncherProps = Omit<
  StakeUnstakeModalProps,
  "onCloseAutoFocus" | "openOnMount" | "trigger"
>;

const DelegateButton = forwardRef<
  HTMLButtonElement,
  {
    onClick?: () => void;
    opening?: boolean;
    onIntent?: () => void;
  }
>(({ onClick, opening = false, onIntent }, ref) => (
  <button
    ref={ref}
    type="button"
    className="mg-hero-action"
    onClick={onClick}
    onPointerEnter={onIntent}
    onFocus={onIntent}
    disabled={opening}
    aria-busy={opening || undefined}
  >
    {opening ? "Opening delegate flow…" : "Delegate"}
  </button>
));
DelegateButton.displayName = "DelegateButton";

/**
 * Keeps the hero action available without eagerly shipping the staking UI.
 *
 * Once the module is ready it remains mounted, so subsequent opens retain the
 * established Sheet trigger/focus behavior from StakeUnstakeModal itself.
 */
export function StakeUnstakeLauncher(props: StakeUnstakeLauncherProps) {
  const [requested, setRequested] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const preload = useCallback(() => {
    void loadStakeUnstakeModal();
  }, []);

  if (!requested) {
    return <DelegateButton onClick={() => setRequested(true)} onIntent={preload} />;
  }

  return (
    <Suspense fallback={<DelegateButton opening />}>
      <StakeUnstakeModal
        {...props}
        openOnMount
        onCloseAutoFocus={() => triggerRef.current?.focus()}
        trigger={(open) => <DelegateButton ref={triggerRef} onClick={open} onIntent={preload} />}
      />
    </Suspense>
  );
}
