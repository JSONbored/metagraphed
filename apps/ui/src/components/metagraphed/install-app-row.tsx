import { Download, Share, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

/**
 * #8384 requirement 4: a dismissible row in /settings -- never a popup,
 * never a nag bar. Renders nothing once dismissed, already installed, or on
 * a browser with no install path at all (see useInstallPrompt's `kind`).
 */
export function InstallAppRow() {
  const { kind, promptInstall, dismiss } = useInstallPrompt();
  if (!kind) return null;

  return (
    <div className="flex items-start gap-3 rounded border border-accent/30 bg-accent-surface px-3 py-2.5">
      <Download className="size-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mg-type-caption font-medium text-ink-strong">Install Metagraphed</div>
        {kind === "native" ? (
          <p className="mt-0.5 mg-type-caption text-ink-muted">
            Add it to your home screen for instant, offline-capable access to your watchlist.
          </p>
        ) : (
          <p className="mt-0.5 mg-type-caption text-ink-muted">
            Tap <Share className="inline size-3 -mt-0.5" aria-hidden /> Share, then "Add to Home
            Screen" for instant, offline-capable access to your watchlist.
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {kind === "native" ? (
          <button
            type="button"
            onClick={promptInstall}
            className="rounded border border-accent/40 bg-primary-soft px-2.5 py-1 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80"
          >
            Install
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="rounded p-1 text-ink-muted hover:text-ink-strong"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
