import { useEffect, type ReactNode } from "react";
import { Check, LogOut } from "lucide-react";
import { CopyableCode } from "@jsonbored/ui-kit";
import { ApiError } from "@/lib/metagraphed/client";
import { WalletConnectPanel } from "@/components/metagraphed/wallet-connect";
import { useWallet } from "@/hooks/use-wallet";
import { useWatchToken } from "@/hooks/use-watch-token";
import { shortHash } from "@/lib/metagraphed/blocks";

// Shared primitives for the "watch this X" alert-trigger forms (#6558). Both
// WatchValidatorAlert (account-scoped) and WatchSubnetAlert (netuid-scoped) POST
// to the same #4984 /api/v1/alerts/triggers endpoint with the same create-token
// gate and owner-token-once-shown result, differing only in which match field
// they send. These are the parts that are identical between them.

// Must match src/alert-triggers.ts — ALERT_TRIGGER_CREATE_TOKEN_HEADER.
export const CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";
// #8374: the self-serve alternative — must match src/alert-triggers.ts's
// WATCH_TRIGGER_TOKEN_HEADER. A request sends at most one of the two.
export const WATCH_TRIGGER_TOKEN_HEADER = "x-watch-trigger-token";

export const CHANNELS = ["webhook", "discord"] as const;
export type Channel = (typeof CHANNELS)[number];

export const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 mg-type-caption-lg text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

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
      className="rounded border border-health-down/30 bg-health-down/5 p-3 mg-type-caption text-health-down"
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
      <span className="mb-1 block mg-type-caption text-ink-muted">
        {label}
        {required ? <span className="text-health-down"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block mg-type-caption text-ink-muted">{hint}</span> : null}
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
            <label key={c} className="inline-flex items-center gap-1.5 mg-type-caption text-ink">
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

/**
 * #8374: the self-serve alternative to pasting an operator-issued creation
 * token — connect a wallet, sign a challenge, and get a 90-day
 * trigger-creation token minted for that address, no operator involved.
 * Calls `onVerified(token)` once a token is active (and `onVerified(null)`
 * if the wallet disconnects or the token is cleared) so the parent form can
 * auto-fill its own token field and remember which header to send it under
 * (WATCH_TRIGGER_TOKEN_HEADER, not CREATE_TOKEN_HEADER — the two are never
 * interchangeable, see src/alert-triggers.ts's own header comment). The
 * manual-entry path (a real metagraphed-operator token) always stays
 * available below this — connecting a wallet is additive, never required.
 */
export function WalletVerifyForToken({
  onVerified,
}: {
  onVerified: (token: string | null) => void;
}) {
  const { wallet, status: walletStatus } = useWallet();
  const watchToken = useWatchToken(wallet);

  useEffect(() => {
    onVerified(watchToken.status === "active" ? watchToken.token : null);
    // onVerified is a fresh closure each render in the two call sites below;
    // re-running it every time watchToken.token/status settles (not on
    // every parent render) is exactly the intended behavior here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchToken.status, watchToken.token]);

  if (walletStatus !== "connected" || !wallet) {
    return (
      <div className="rounded border border-border bg-surface/40 p-3">
        <p className="mb-2 mg-type-caption text-ink-muted">
          Or connect a wallet to verify yourself — no operator token needed.
        </p>
        <WalletConnectPanel />
      </div>
    );
  }

  if (watchToken.status === "active" && watchToken.token) {
    return (
      <div className="flex items-center justify-between gap-2 rounded border border-ink-strong/40 bg-surface px-2 py-1.5">
        <span className="inline-flex items-center gap-1.5 mg-type-caption text-ink-strong">
          <Check className="size-3.5 text-health-ok shrink-0" aria-hidden="true" />
          Verified with wallet {shortHash(wallet.address, 4)} — token filled in below.
        </span>
        <button
          type="button"
          onClick={watchToken.clear}
          className="inline-flex shrink-0 items-center gap-1 mg-type-caption text-ink-muted hover:text-ink-strong"
        >
          <LogOut className="size-3 shrink-0" aria-hidden="true" />
          Use a different token
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border border-border bg-surface/40 p-3">
      <p className="mg-type-caption text-ink-muted">
        Sign a one-time message with {shortHash(wallet.address, 4)} to verify yourself instead of
        pasting an operator token. This never constructs or broadcasts a transaction.
      </p>
      {watchToken.status === "error" && watchToken.error ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 mg-type-caption text-health-down"
        >
          {watchToken.error}
        </div>
      ) : null}
      <button
        type="button"
        onClick={watchToken.issue}
        disabled={watchToken.status === "issuing"}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
      >
        {watchToken.status === "issuing" ? "Verifying…" : "Verify with wallet"}
      </button>
    </div>
  );
}

/** The one-time result panel: the trigger id + the owner token shown once. */
export function CreatedTokenPanel({ id, ownerToken }: { id: string; ownerToken: string }) {
  return (
    <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
      <p className="mg-type-caption font-medium text-health-warn">
        The owner token below is shown once and is never echoed back by GET — store it now to manage
        or delete this alert later via the API.
      </p>
      <CopyableCode label="id" value={id} truncate={false} className="w-full" />
      {/* ph-no-capture: excludes this one-time secret reveal from PostHog
          session replay (metagraphed#7761) -- rrweb's own blockClass
          marker, see analytics.ts's session_recording config. */}
      <CopyableCode
        label="owner token"
        value={ownerToken}
        truncate={false}
        className="w-full ph-no-capture"
      />
    </div>
  );
}
