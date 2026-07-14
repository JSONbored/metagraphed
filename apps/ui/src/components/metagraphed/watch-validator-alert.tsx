import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { CopyableCode } from "@jsonbored/ui-kit";
import { Skeleton } from "@/components/metagraphed/states";
import type { AlertTriggerCreated } from "@/lib/metagraphed/types";

// Must match src/alert-triggers.mjs — ALERT_TRIGGER_CREATE_TOKEN_HEADER.
const CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";

// #4984's event_kind is a single value per trigger (not a filter list), so
// this is a single-select rather than the webhook manager's checkbox-set
// "kinds" pattern. Leaving it unset still matches every event for this
// hotkey (validateAlertTriggerInput requires only one of
// netuid/event_kind/account/min_amount_tao — `account` below always
// satisfies that on its own).
const EVENT_KINDS = [
  { value: "", label: "Any delegation or stake event" },
  { value: "DelegateAdded", label: "New delegation" },
  { value: "StakeAdded", label: "Stake added" },
] as const;

const CHANNELS = ["webhook", "discord"] as const;

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

/** Distinguishes the create-token gate, validation, and rate-limit rejections. */
function describeApiError(error: unknown): string {
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

interface CreateVariables {
  token: string;
  eventKind: string;
  channel: (typeof CHANNELS)[number];
  destination: string;
}

/** "Watch this validator": a scoped alert trigger (account=hotkey) over the existing #4984 alerts API. */
export function WatchValidatorAlert({ hotkey }: { hotkey: string }) {
  const [token, setToken] = useState("");
  const [eventKind, setEventKind] = useState("");
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("webhook");
  const [destination, setDestination] = useState("");

  const mutation = useMutation({
    mutationFn: async (vars: CreateVariables): Promise<AlertTriggerCreated> => {
      const res = await apiFetch<AlertTriggerCreated>("/api/v1/alerts/triggers", {
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CREATE_TOKEN_HEADER]: vars.token,
          },
          body: JSON.stringify({
            account: hotkey,
            ...(vars.eventKind ? { event_kind: vars.eventKind } : {}),
            channel: vars.channel,
            destination: vars.destination,
          }),
        },
      });
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    mutation.mutate({
      token: token.trim(),
      eventKind,
      channel,
      destination: destination.trim(),
    });
  }

  const result = mutation.data;

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-[13px] text-ink-muted">
        Get a webhook or Discord notification when this validator receives new delegations or stake.
        Creation requires a trigger token issued by a metagraphed operator — this app never bundles
        one.
      </p>
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field
          label="Event"
          hint="Leave as 'any' to watch every delegation/stake event for this hotkey."
        >
          <select
            value={eventKind}
            onChange={(e) => setEventKind(e.target.value)}
            className={inputCls}
          >
            {EVENT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Delivery channel">
          <div className="flex gap-4">
            {CHANNELS.map((c) => (
              <label key={c} className="inline-flex items-center gap-1.5 text-[12px] text-ink">
                <input
                  type="radio"
                  name="channel"
                  checked={channel === c}
                  onChange={() => setChannel(c)}
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
            onChange={(e) => setDestination(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field
          label="Creation token"
          required
          hint="Provided out-of-band by a metagraphed operator."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={inputCls}
          />
        </Field>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
        >
          {mutation.isPending ? "Creating…" : "Watch this validator"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="h-20 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {result ? (
        <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="text-[12px] font-medium text-health-warn">
            The owner token below is shown once and is never echoed back by GET — store it now to
            manage or delete this alert later via the API.
          </p>
          <CopyableCode label="id" value={result.id} truncate={false} className="w-full" />
          <CopyableCode
            label="owner token"
            value={result.owner_token}
            truncate={false}
            className="w-full"
          />
        </div>
      ) : null}
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
    >
      {message}
    </div>
  );
}

function Field({
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
