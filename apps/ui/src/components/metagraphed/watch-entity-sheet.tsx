import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { CopyableCode, ExternalLink } from "@jsonbored/ui-kit";
import { Link } from "@tanstack/react-router";
import { API_BASE } from "@/lib/metagraphed/config";
import { apiSnippet } from "./endpoint-snippet";

// #8257: the backend has published per-subnet combined feeds (RSS/Atom/JSON)
// and a self-service webhook subscription API for a while, but the only place
// either was reachable was /settings -- i.e. nowhere near the entity you'd
// actually want to follow. This is the "how do I hear about changes to *this*"
// affordance, on the page where you form that intention.
//
// No accounts and no email, deliberately: a feed URL and a webhook are both
// things the reader already has somewhere to put, and neither needs us to hold
// an identity for them.

const FORMATS = [
  { suffix: ".rss", label: "RSS" },
  { suffix: ".atom", label: "Atom" },
  { suffix: ".json", label: "JSON Feed" },
] as const;

export function WatchEntitySheet({ netuid, name }: { netuid: number; name?: string }) {
  const [open, setOpen] = useState(false);
  const base = `${API_BASE}/api/v1/feeds/subnets/${netuid}`;
  const label = name ? `${name} (SN${netuid})` : `SN${netuid}`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="mg-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded px-2 py-1 mg-type-caption font-medium text-ink-muted transition-colors hover:bg-surface hover:text-ink-strong"
      >
        <Bell className="size-3.5" aria-hidden />
        Follow
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Follow ${label}`}
          className="fixed inset-0 z-[var(--mg-z-modal)] flex items-end sm:items-center sm:justify-center"
        >
          <div
            className="absolute inset-0 bg-ink-strong/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="relative z-[var(--mg-z-sticky)] mg-scroll max-h-[85vh] w-full overflow-y-auto rounded-t-xl border-t border-border bg-card p-4 sm:mx-4 sm:max-w-lg sm:rounded-xl sm:border">
            <div className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0">
                <span className="mg-type-label uppercase text-ink-strong">Follow {label}</span>
                <p className="mt-1 mg-type-caption text-ink-muted">
                  Registry changes and incidents for this subnet. No account, no email — a feed URL
                  or a webhook, both of which you already have somewhere to put.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="mg-tap-target inline-flex size-8 shrink-0 items-center justify-center rounded text-ink-muted hover:text-ink-strong"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <section className="space-y-2">
              <h3 className="mg-type-label uppercase text-ink-muted">Feed</h3>
              {FORMATS.map((f) => (
                <div key={f.suffix} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 mg-type-caption text-ink-muted">{f.label}</span>
                  <CopyableCode
                    label={f.label}
                    value={`${base}${f.suffix}`}
                    className="min-w-0 flex-1"
                  />
                </div>
              ))}
              <div className="pt-1">
                <span className="mg-type-caption text-ink-muted">Or fetch it directly:</span>
                <CopyableCode
                  label="curl"
                  value={apiSnippet("curl", `${base}.json`)}
                  className="mt-1 min-w-0 max-w-full"
                />
              </div>
            </section>

            <section className="mt-4 space-y-2 border-t border-border pt-4">
              <h3 className="mg-type-label uppercase text-ink-muted">Webhook</h3>
              <p className="mg-type-caption text-ink-muted">
                For a push instead of a poll, create a subscription against the public subscription
                API. The operator-issued token flow is unchanged — set it up on{" "}
                <Link
                  to="/settings"
                  className="text-accent-text hover:underline"
                  onClick={() => setOpen(false)}
                >
                  developer settings
                </Link>
                , filtering to this subnet.
              </p>
              <ExternalLink href={`${API_BASE}/api/v1/webhooks/subscriptions`}>
                Subscription API
              </ExternalLink>
            </section>
          </div>
        </div>
      ) : null}
    </>
  );
}
