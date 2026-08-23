import { Bell } from "lucide-react";
import {
  CopyableCode,
  ExternalLink,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@jsonbored/ui-kit";
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
//
// #11612: this was a hand-rolled `role="dialog"` with its own overlay, its own
// Escape handler, its own body-scroll lock and four arbitrary Tailwind values
// (`z-[var(--mg-z-modal)]`, `max-h-[85vh]`). ui-kit's Sheet does all of that,
// correctly, including focus trapping and restoration -- which the hand-rolled
// version never did.

const FORMATS = [
  { suffix: ".rss", label: "RSS" },
  { suffix: ".atom", label: "Atom" },
  { suffix: ".json", label: "JSON Feed" },
] as const;

export function WatchEntitySheet({ netuid, name }: { netuid: number; name?: string }) {
  const base = `${API_BASE}/api/v1/feeds/subnets/${netuid}`;
  const label = name ? `${name} (SN${netuid})` : `SN${netuid}`;

  return (
    <Sheet>
      <SheetTrigger className="mg-hero-icon-action">
        <Bell className="size-3.5" aria-hidden />
        Follow
      </SheetTrigger>
      <SheetContent side="right" className="mg-scroll overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Follow {label}</SheetTitle>
          <SheetDescription>
            Registry changes and incidents for this subnet. No account, no email — a feed URL or a
            webhook, both of which you already have somewhere to put.
          </SheetDescription>
        </SheetHeader>

        <section className="mt-4 space-y-2">
          <h3 className="text-11 text-ink-muted">Feed</h3>
          {FORMATS.map((f) => (
            <div key={f.suffix} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-13 text-ink-muted">{f.label}</span>
              <CopyableCode
                label={f.label}
                value={`${base}${f.suffix}`}
                className="min-w-0 flex-1"
              />
            </div>
          ))}
          <div className="pt-1">
            <span className="text-13 text-ink-muted">Or fetch it directly:</span>
            <CopyableCode
              label="curl"
              value={apiSnippet("curl", `${base}.json`)}
              className="mt-1 min-w-0 max-w-full"
            />
          </div>
        </section>

        <section className="mt-4 space-y-2 border-t border-border pt-4">
          <h3 className="text-11 text-ink-muted">Webhook</h3>
          <p className="text-13 text-ink-muted">
            For a push instead of a poll, create a subscription against the public subscription API.
            The operator-issued token flow is unchanged — set it up on{" "}
            <Link to="/settings" className="text-accent-text hover:underline">
              developer settings
            </Link>
            , filtering to this subnet.
          </p>
          <ExternalLink href={`${API_BASE}/api/v1/webhooks/subscriptions`}>
            Subscription API
          </ExternalLink>
        </section>
      </SheetContent>
    </Sheet>
  );
}
