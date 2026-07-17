import { type ReactNode } from "react";
import { CopyableCode } from "@jsonbored/ui-kit";
import { ApiError } from "@/lib/metagraphed/client";

// Shared primitives for the "watch this X" alert-trigger forms (#6558). Both
// WatchValidatorAlert (account-scoped) and WatchSubnetAlert (netuid-scoped) POST
// to the same #4984 /api/v1/alerts/triggers endpoint with the same create-token
// gate and owner-token-once-shown result, differing only in which match field
// they send. These are the parts that are identical between them.

// Must match src/alert-triggers.mjs — ALERT_TRIGGER_CREATE_TOKEN_HEADER.
export const CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";

export const CHANNELS = ["webhook", "discord"] as const;
export type Channel = (typeof CHANNELS)[number];

export const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

/** Distinguishes the create-token gate, validation, and rate-limit rejections. */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Unauthorized — check your creation token.";
    if (error.status === 429) return "Too many requests — slow down and try again shortly.";
    if (error.status === 503) return "Alert triggers aren't enabled on this deployment yet.";
    if (error.status === 400) {
      return "Invalid alert configuration — check the destination format for the selected channel.";
    }
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
    >
      {message}
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
        {required ? <span className="text-health-down"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span> : null}
    </label>
  );
}

/** The delivery-channel radio group + the destination URL field, identical
 *  between the two watch forms. */
export function ChannelAndDestinationFields({
  channel,
  onChannelChange,
  destination,
  onDestinationChange,
}: {
  channel: Channel;
  onChannelChange: (c: Channel) => void;
  destination: string;
  onDestinationChange: (d: string) => void;
}) {
  return (
    <>
      <Field label="Delivery channel">
        <div className="flex gap-4">
          {CHANNELS.map((c) => (
            <label key={c} className="inline-flex items-center gap-1.5 text-[12px] text-ink">
              <input
                type="radio"
                name="channel"
                checked={channel === c}
                onChange={() => onChannelChange(c)}
              />
              <span className="capitalize">{c}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        label={channel === "discord" ? "Discord webhook URL" : "Webhook URL"}
        required
        hint={
          channel === "discord"
            ? "A Discord incoming-webhook URL (Server Settings → Integrations → Webhooks)."
            : "A public HTTPS endpoint that will receive the alert POST."
        }
      >
        <input
          type="url"
          required
          placeholder={
            channel === "discord"
              ? "https://discord.com/api/webhooks/…"
              : "https://hooks.example.com/alert"
          }
          value={destination}
          onChange={(e) => onDestinationChange(e.target.value)}
          className={inputCls}
        />
      </Field>
    </>
  );
}

/** The one-time result panel: the trigger id + the owner token shown once. */
export function CreatedTokenPanel({ id, ownerToken }: { id: string; ownerToken: string }) {
  return (
    <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
      <p className="text-[12px] font-medium text-health-warn">
        The owner token below is shown once and is never echoed back by GET — store it now to manage
        or delete this alert later via the API.
      </p>
      <CopyableCode label="id" value={id} truncate={false} className="w-full" />
      <CopyableCode label="owner token" value={ownerToken} truncate={false} className="w-full" />
    </div>
  );
}
