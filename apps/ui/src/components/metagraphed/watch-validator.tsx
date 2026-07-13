import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { CopyableCode } from "@jsonbored/ui-kit";

// Must match src/alert-triggers.mjs (ALERT_TRIGGER_CREATE_TOKEN_HEADER).
const CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";
// Discord incoming-webhook URLs — everything else is treated as a plain webhook.
const DISCORD_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//i;

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

interface AlertTriggerCreated {
  id: string;
  channel: string;
  account: string | null;
  owner_token: string;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Unauthorized — check your create token.";
    if (error.status === 503) return error.message || "Alerts are disabled on this deployment.";
    if (error.status === 400) return error.message || "That alert configuration was rejected.";
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

/**
 * One-step "watch this validator": creates an alert trigger scoped to this
 * hotkey's stake/delegation events via the existing /api/v1/alerts/triggers
 * API (#5167). The channel is inferred from the URL (Discord webhook vs plain
 * webhook); the create token is the API's own anti-abuse secret. Server-side
 * validateAlertTriggerInput is the source of truth — its error is surfaced
 * directly rather than re-implemented here.
 */
export function WatchValidator({ hotkey }: { hotkey: string }) {
  const [destination, setDestination] = useState("");
  const [token, setToken] = useState("");

  const mutation = useMutation({
    mutationFn: async (): Promise<AlertTriggerCreated> => {
      const channel = DISCORD_WEBHOOK.test(destination.trim()) ? "discord" : "webhook";
      const res = await apiFetch<AlertTriggerCreated>("/api/v1/alerts/triggers", {
        init: {
          method: "POST",
          headers: { "content-type": "application/json", [CREATE_TOKEN_HEADER]: token.trim() },
          body: JSON.stringify({ account: hotkey, channel, destination: destination.trim() }),
        },
      });
      return res.data;
    },
  });

  const created = mutation.data;
  const canSubmit = destination.trim() !== "" && token.trim() !== "" && !mutation.isPending;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) mutation.mutate();
  }

  if (created) {
    return (
      <div className="rounded-lg border border-accent/40 bg-primary-soft/40 p-4">
        <div className="flex items-center gap-2 font-medium text-ink-strong">
          <Check className="size-4 shrink-0 text-accent" />
          You&rsquo;re watching this validator
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Stake &amp; delegation events for this hotkey will be delivered to your {created.channel}. Save
          the owner token below — it&rsquo;s shown once and is needed to edit or remove this alert.
        </p>
        <div className="mt-2">
          <CopyableCode label="owner token" value={created.owner_token} truncate={false} className="max-w-full" />
        </div>
        <button
          type="button"
          onClick={() => mutation.reset()}
          className="mt-3 inline-flex items-center rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          Set up another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="url"
          inputMode="url"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="Webhook or Discord webhook URL"
          aria-label="Delivery URL"
          className={inputCls}
        />
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Create token"
          aria-label="Alert create token"
          className={`${inputCls} sm:w-44`}
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex shrink-0 items-center justify-center rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[13px] font-medium text-accent-text transition-colors hover:bg-accent/15 disabled:opacity-50"
        >
          {mutation.isPending ? "Watching…" : "Watch"}
        </button>
      </div>
      {mutation.isError ? (
        <p className="mt-2 text-xs text-health-down">{describeError(mutation.error)}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-ink-muted">
        The create token is an anti-abuse secret — ask a maintainer for one.
      </p>
    </form>
  );
}
