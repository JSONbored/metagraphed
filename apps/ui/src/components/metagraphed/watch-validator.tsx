import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { classNames } from "@/lib/metagraphed/format";
import { CopyableCode } from "@jsonbored/ui-kit";
import { Skeleton } from "@/components/metagraphed/states";

// Anti-abuse gate on trigger creation — an operator-issued shared secret, the
// same out-of-band model the webhook-subscription form uses. This app never
// bundles one (see src/alert-triggers.mjs ALERT_TRIGGER_CREATE_TOKEN_HEADER).
const CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";

// Delivery channels surfaced here: both take a single https destination URL, so
// one input + one validator covers them. email / telegram exist on the backend
// (src/alert-triggers.mjs) but need different destination shapes — out of scope.
const CHANNELS = [
  {
    id: "webhook",
    label: "Webhook",
    placeholder: "https://hooks.example.com/mg",
    hint: "Any public https endpoint. Deliveries POST the matching event as JSON.",
  },
  {
    id: "discord",
    label: "Discord",
    placeholder: "https://discord.com/api/webhooks/…",
    hint: "A Discord channel's incoming-webhook URL.",
  },
] as const;
type ChannelId = (typeof CHANNELS)[number]["id"];

// The delegation / stake events a validator-watch can fire on. A trigger matches
// exactly one event_kind; watch both by creating one alert for each.
const EVENTS = [
  { id: "DelegateAdded", label: "New delegation", hint: "someone delegates to this validator" },
  { id: "StakeAdded", label: "Stake added", hint: "stake is added on this hotkey" },
] as const;
type EventId = (typeof EVENTS)[number]["id"];

// Client-side mirror of src/alert-triggers.mjs `isValidAlertDestination`, so an
// obvious typo is caught before the POST. The server re-validates (incl. the
// SSRF/public-URL check for `webhook`), which stays the source of truth.
const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
function destinationLooksValid(channel: ChannelId, destination: string): boolean {
  if (destination.length === 0) return false;
  if (channel === "discord") return DISCORD_WEBHOOK_PATTERN.test(destination);
  return /^https:\/\/\S+$/i.test(destination);
}

interface AlertTriggerCreated {
  id: string;
  owner_token: string;
  channel: string;
  destination: string;
  account: string | null;
  event_kind: string | null;
  min_amount_tao: number | null;
}

function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Unauthorized — check your alert create token.";
    if (error.status === 400)
      return error.message || "The alert configuration was rejected — check the destination URL.";
    if (error.status === 429)
      return "Rate limited — too many triggers created recently. Try later.";
    if (error.status === 503) return error.message || "Alerts are disabled on this deployment.";
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

/**
 * "Watch this validator" — creates a real alert trigger scoped to one validator
 * hotkey's delegation/stake events via the existing `/api/v1/alerts/triggers`
 * endpoint (#5167). The account condition is fixed to this page's hotkey; the
 * visitor only picks the event, delivery channel, and destination.
 */
export function WatchValidatorForm({ hotkey }: { hotkey: string }) {
  const [channel, setChannel] = useState<ChannelId>("webhook");
  const [destination, setDestination] = useState("");
  const [eventKind, setEventKind] = useState<EventId>("DelegateAdded");
  const [minTaoRaw, setMinTaoRaw] = useState("");
  const [createToken, setCreateToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<AlertTriggerCreated> => {
      const body: Record<string, unknown> = {
        channel,
        destination: destination.trim(),
        account: hotkey,
        event_kind: eventKind,
      };
      const min = minTaoRaw.trim();
      if (min) body.min_amount_tao = Number(min);
      const res = await apiFetch<AlertTriggerCreated>("/api/v1/alerts/triggers", {
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CREATE_TOKEN_HEADER]: createToken.trim(),
          },
          body: JSON.stringify(body),
        },
      });
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dest = destination.trim();
    if (!destinationLooksValid(channel, dest)) {
      setFormError(
        channel === "discord"
          ? "Enter a valid Discord incoming-webhook URL."
          : "Enter a valid https webhook URL.",
      );
      return;
    }
    const min = minTaoRaw.trim();
    if (min && !(Number.isFinite(Number(min)) && Number(min) >= 0)) {
      setFormError("Minimum amount must be a non-negative number of τ.");
      return;
    }
    setFormError(null);
    mutation.mutate();
  }

  const activeChannel = CHANNELS.find((c) => c.id === channel)!;
  const result = mutation.data;

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-[13px] text-ink-muted">
        Get notified when this validator gains a delegation or stake. This creates a real alert
        trigger on <code className="text-ink">/api/v1/alerts/triggers</code> scoped to{" "}
        <span className="font-mono text-ink">account = this hotkey</span>. Creation needs an alert
        create token issued by a metagraphed operator — this app never bundles one.
      </p>

      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field label="Event to watch" required>
          <div className="flex flex-wrap gap-2">
            {EVENTS.map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => setEventKind(ev.id)}
                aria-pressed={eventKind === ev.id}
                className={classNames(
                  "rounded border px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  eventKind === ev.id
                    ? "border-accent/50 bg-primary-soft text-ink-strong"
                    : "border-border bg-card text-ink-muted hover:border-ink/30",
                )}
              >
                <span className="block font-medium">{ev.label}</span>
                <span className="block text-[10px] text-ink-muted">{ev.hint}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Delivery channel" required>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChannel(c.id)}
                aria-pressed={channel === c.id}
                className={classNames(
                  "rounded border px-3 py-1.5 text-[12px] font-medium transition-colors",
                  channel === c.id
                    ? "border-accent/50 bg-primary-soft text-ink-strong"
                    : "border-border bg-card text-ink-muted hover:border-ink/30",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label={`${activeChannel.label} URL`} required hint={activeChannel.hint}>
          <input
            type="url"
            required
            placeholder={activeChannel.placeholder}
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setFormError(null);
            }}
            className={inputCls}
          />
        </Field>

        <Field
          label="Minimum amount (τ)"
          hint="Optional — only fire above this stake/delegation size."
        >
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            placeholder="e.g. 100"
            value={minTaoRaw}
            onChange={(e) => {
              setMinTaoRaw(e.target.value);
              setFormError(null);
            }}
            className={inputCls}
          />
        </Field>

        <Field
          label="Alert create token"
          required
          hint="Provided out-of-band by a metagraphed operator."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={createToken}
            onChange={(e) => setCreateToken(e.target.value)}
            className={inputCls}
          />
        </Field>

        {formError ? <p className="text-[11px] text-health-down">{formError}</p> : null}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
        >
          {mutation.isPending ? "Creating…" : "Watch this validator"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {result ? (
        <div className="mt-3 space-y-3 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="text-[12px] font-medium text-health-warn">
            The owner token below is shown once and is never echoed back — store it now. It's the
            only credential that can edit or delete this alert.
          </p>
          <CopyableCode label="trigger id" value={result.id} truncate={false} className="w-full" />
          <CopyableCode
            label="owner token"
            value={result.owner_token}
            truncate={false}
            className="w-full"
          />
          <p className="text-[11px] text-ink-muted">
            Watching <span className="font-mono text-ink">{result.event_kind}</span> on{" "}
            <span className="font-mono text-ink">{shortAccount(result.account)}</span> via{" "}
            {result.channel}
            {result.min_amount_tao != null ? ` · ≥ ${result.min_amount_tao} τ` : ""}.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function shortAccount(account: string | null): string {
  if (!account) return "—";
  return account.length > 14 ? `${account.slice(0, 8)}…${account.slice(-4)}` : account;
}

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
    >
      {message}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={classNames("block", className)}>
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
        {required ? <span className="text-health-down"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span> : null}
    </label>
  );
}
