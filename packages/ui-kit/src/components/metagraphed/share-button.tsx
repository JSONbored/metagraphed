import { useEffect, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { toast } from "sonner";
import { classNames } from "@/lib/format";
import { useCopy } from "@/hooks/use-copy";

/**
 * Fired on `window` when a share link is successfully copied. Consumers that
 * care (analytics) subscribe; ui-kit itself stays dependency-free.
 */
export const SHARE_COPIED_EVENT = "mg:share-copied";
import { CopyStatusRegion } from "./copy-status-region";

interface Props {
  /** Optional explicit URL; defaults to current window.location.href. */
  url?: string;
  label?: string;
  className?: string;
  /**
   * Borderless variant for grouping inside an `ActionBar` segmented pill.
   * Composes independently with `iconOnly` — `bare` alone keeps the label
   * text (just drops the border); `bare iconOnly` together is a borderless
   * icon-only segment sized to match ActionBar's other compact buttons
   * (e.g. StaleBanner's `bare` refresh button).
   */
  bare?: boolean;
  /**
   * Hide the label text, showing just the icon — for a row of
   * universally-recognized icons where a text label is redundant clutter.
   * The label still reaches assistive tech via `aria-label`/`title`.
   * Without `bare`, renders as a standalone bordered square button
   * (matching PrimaryLinksRail's non-`bare` icon-button style).
   */
  iconOnly?: boolean;
  /**
   * Icon-only, borderless square segment (fixed size-8, no own
   * border/rounded/bg) meant to sit inside a shared `divide-x` bar
   * alongside other icon actions (e.g. `PrimaryLinksRail bare`) —
   * matching SegmentedToggle/ViewModeToggle's one connected-bar look.
   * Takes precedence over `bare`/`iconOnly` if set.
   */
  connected?: boolean;
}

export function ShareButton({
  url,
  label = "Share view",
  className,
  bare,
  iconOnly,
  connected,
}: Props) {
  const hideText = connected || iconOnly;
  // #3425: reuse the shared useCopy hook for the clipboard write, copied-state,
  // and reset timer (the app-wide primitive every other copy affordance uses),
  // keeping ShareButton's two extras it doesn't cover — the window.location.href
  // fallback and the sr-only aria-live announcement. toastOnSuccess is off so the
  // distinct "Link copied" success toast below is preserved; useCopy already
  // surfaces the failure toast, so the error path isn't double-notified.
  const { copied, copy } = useCopy({ toastOnSuccess: false });
  const [announcement, setAnnouncement] = useState("");

  // Reset the sr-only announcement back to empty once the copied state clears
  // (via useCopy's own timer), reproducing the original's `setAnnouncement("")`
  // reset without introducing a second parallel timer — driven off useCopy's
  // `copied` return value as the issue directs. The failure announcement, which
  // never sets `copied`, persists as it did originally.
  useEffect(() => {
    if (!copied) setAnnouncement("");
  }, [copied]);

  const onClick = async () => {
    const href =
      url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href) return;
    const ok = await copy(href);
    if (ok) {
      toast.success("Link copied", {
        description: "Filters, sort, and pagination are preserved in the URL.",
      });
      setAnnouncement(`Link copied to clipboard: ${href}`);
      // #8256: ui-kit is a design-system package and deliberately has no
      // analytics dependency, so it announces the copy as a DOM event instead
      // of calling captureEvent. apps/ui registers one listener in AppShell.
      // The event carries no URL -- the pathname alone would identify which
      // subnet or account was being shared.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(SHARE_COPIED_EVENT));
      }
    } else {
      setAnnouncement("Couldn't copy link to clipboard.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label="Copy link with current filters, sort, and page"
        title="Copy link with current filters, sort, and page"
        className={classNames(
          connected
            ? "inline-flex size-8 items-center justify-center text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            : bare
              ? iconOnly
                ? "inline-flex items-center justify-center rounded p-1 min-h-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : // #8467: px-1 sm:px-2 (not a flat px-2) so the button doesn't
                  // carry text-sized padding once the label itself disappears
                  // below sm -- see the label span's hidden/sm:inline pairing.
                  "inline-flex items-center gap-1.5 rounded px-1 sm:px-2 py-1 min-h-8 mg-type-caption font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : iconOnly
                ? "inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-ink-muted hover:border-ink/30 hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : "inline-flex items-center gap-1.5 rounded border border-border bg-card px-1.5 sm:px-2.5 py-1 mg-type-caption font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {copied ? (
          <Check
            className={
              connected || (iconOnly && !bare)
                ? "size-4 text-health-ok"
                : "size-3 text-health-ok"
            }
          />
        ) : (
          <Share2
            className={
              connected || (iconOnly && !bare)
                ? "size-4"
                : "size-3 text-ink-muted"
            }
          />
        )}
        {/* #8467: every masthead's ActionBar renders this un-iconOnly variant
            (`<ShareButton bare />`), so a bordered "Share view" pill was the
            widest, loudest element in the masthead on a narrow viewport --
            worse the longer the page's own title got (first visibly bad on
            /agents). The icon is a universally-recognized affordance on its
            own; the label earns its place back once there's room for it. */}
        {hideText ? null : (
          <span className="hidden sm:inline">
            {copied ? "Link copied" : label}
          </span>
        )}
      </button>
      {/* Screen-reader status — the shared region every copy control now uses. */}
      <CopyStatusRegion>{announcement}</CopyStatusRegion>
    </>
  );
}
