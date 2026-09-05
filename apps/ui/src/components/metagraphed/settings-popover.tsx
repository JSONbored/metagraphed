import { useEffect, useRef, useState, type RefObject } from "react";
import { Settings } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";

type PanelComponent = typeof import("./settings-panel").default;

/**
 * Single header gear button. Controls load only when this popover or the mobile
 * navigation mounts them; closed settings add no panel request to a route visit.
 */
export function SettingsPopover() {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Settings"
          className="inline-flex items-center justify-center rounded border border-border min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-rule-strong transition-colors"
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <ClampedPopoverContent ref={contentRef} align="end" className="w-72 p-3">
        <SettingsPanel focusWithinRef={contentRef} />
      </ClampedPopoverContent>
    </Popover>
  );
}

/** Shared deferred controls for the desktop popover and mobile navigation. */
export function SettingsPanel({
  focusWithinRef,
}: {
  focusWithinRef?: RefObject<HTMLElement | null>;
}) {
  const [Panel, setPanel] = useState<PanelComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    void import("./settings-panel").then(
      (module) => {
        if (mounted) setPanel(() => module.default);
      },
      () => {
        if (mounted) setFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // Radix focuses the empty popover while the chunk loads. Complete its usual
    // first-control focus only if the reader has stayed inside it. The mobile
    // sheet keeps focus in its navigation, and a closed panel cannot steal it.
    if ((Panel || failed) && focusWithinRef?.current?.contains(document.activeElement)) {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [Panel, failed, focusWithinRef]);

  return (
    <div ref={panelRef}>
      {Panel ? (
        <Panel />
      ) : failed ? (
        <div role="alert" className="space-y-2 text-13 text-ink-muted">
          <p>Settings could not load.</p>
          <button
            type="button"
            className="min-h-9 rounded border border-border px-2 text-13 text-ink-strong hover:border-rule-strong"
            onClick={() => window.location.reload()}
          >
            Reload settings
          </button>
        </div>
      ) : (
        <p role="status" className="text-13 text-ink-muted">
          Loading settings…
        </p>
      )}
    </div>
  );
}
