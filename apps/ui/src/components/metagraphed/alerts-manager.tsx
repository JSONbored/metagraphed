import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { PushDevicesManager } from "@/components/metagraphed/push-devices-manager";
import { classNames } from "@/lib/metagraphed/format";
import { SectionHeading, TimeAgo } from "@jsonbored/ui-kit";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useWallet } from "@/hooks/use-wallet";
import { useWatchToken } from "@/hooks/use-watch-token";

// #8375: the Alert Center -- lists, pauses/resumes, edits, and deletes a
// verified address' own chain_alert_triggers, plus each trigger's recent
// delivery history. Same wallet-gate shape as ApiKeysManager (connect ->
// sign a challenge -> act), but over the sibling watch-token pair
// (use-watch-token.ts, #8374) rather than use-api-session.ts's RPC login --
// a watch token is a DIFFERENT credential scoped to this one capability
// (managing your own alert triggers), not a fullnode-access session.
const WATCH_TOKEN_HEADER = "x-watch-trigger-token";

interface AlertConditionView {
  metric: string;
  operator: string;
  threshold: number;
}

// #8375: chain_alert_triggers.created_at/last_matched_at and
// chain_alert_deliveries.delivered_at are Postgres BIGINT epoch-ms columns,
// returned as-is by ownerAlertTriggerView/deliveryRecordView (src/alert-
// triggers.ts) -- unlike every other timestamp field this app's API surface
// exposes (always a pre-formatted ISO string), so these arrive over the
// wire as a raw epoch-ms number OR numeric string depending on the
// driver's own BIGINT serialization. epochMsToIso below normalizes either
// shape into the ISO string TimeAgo actually expects.
type EpochMs = string | number | null;

interface OwnerAlertTriggerView {
  id: string;
  name: string | null;
  table_filter: string[] | null;
  netuid: number | null;
  event_kind: string | null;
  account: string | null;
  min_amount_tao: number | null;
  condition: AlertConditionView | null;
  channel: "webhook" | "email" | "telegram" | "discord";
  destination: string;
  active: boolean;
  created_at: EpochMs;
  updated_at: EpochMs;
  last_matched_at: EpochMs;
  match_count: number;
  owner_ss58: string | null;
}

interface DeliveryRecordView {
  id: string;
  delivered_at: EpochMs;
  success: boolean;
  status_code: number | null;
  retry_count: number;
  response_snippet: string | null;
}

function epochMsToIso(value: EpochMs): string | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

function watchHeaders(token: string): HeadersInit {
  return { [WATCH_TOKEN_HEADER]: token };
}

function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your wallet verification expired -- sign in again.";
    if (error.status === 503) return error.message || "Not provisioned on this deployment.";
    if (error.status === 429) return "Too many requests -- slow down and try again.";
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

/**
 * A human-readable summary of what a trigger matches -- the same fields
 * validateAlertTriggerInput accepts (src/alert-triggers.ts), rendered as one
 * line instead of a raw JSON dump. `null` fields are simply omitted; a
 * trigger with none of them set never round-trips (the API rejects it at
 * creation), so the "no filters" fallback only ever shows for a
 * genuinely condition-only trigger.
 */
export function summarizeTriggerFilter(trigger: OwnerAlertTriggerView): string {
  const parts: string[] = [];
  if (trigger.event_kind) parts.push(trigger.event_kind);
  if (trigger.account) parts.push(`account ${trigger.account.slice(0, 6)}…`);
  if (trigger.min_amount_tao != null) parts.push(`≥ ${trigger.min_amount_tao} TAO`);
  if (trigger.condition) {
    parts.push(
      `${trigger.condition.metric} ${trigger.condition.operator} ${trigger.condition.threshold}`,
    );
  }
  if (trigger.table_filter?.length) parts.push(trigger.table_filter.join("/"));
  return parts.length ? parts.join(" · ") : "any matching event";
}

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 mg-type-caption-lg text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

export function AlertsManager() {
  const { wallet, status: walletStatus } = useWallet();
  const watchToken = useWatchToken(wallet);

  return (
    <section aria-labelledby="alerts-heading">
      <SectionHeading
        id="alerts-heading"
        title="Alerts"
        intro="Chain alert triggers you've created with a verified wallet -- pause, edit, or delete, and see recent delivery attempts. Re-verify with your wallet to view (read scope only, never a transaction)."
      />
      <Panel as="div" dense>
        {walletStatus !== "connected" || !wallet ? (
          <EmptyState
            title="Connect your wallet"
            description="Connect a wallet from the header above to sign in and manage your alerts."
          />
        ) : watchToken.status === "active" && watchToken.token ? (
          <AlertsPanel token={watchToken.token} onSignOut={watchToken.clear} />
        ) : (
          <AlertsSignInPrompt
            signingIn={watchToken.status === "issuing"}
            error={watchToken.error}
            onSignIn={watchToken.issue}
          />
        )}
      </Panel>
    </section>
  );
}

function AlertsSignInPrompt({
  signingIn,
  error,
  onSignIn,
}: {
  signingIn: boolean;
  error: string | null;
  onSignIn: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="mg-type-caption text-ink-muted">
        Sign a one-time message with your connected wallet to view and manage the alert triggers you
        created with it. This never constructs or broadcasts a transaction -- it only proves you
        control this address.
      </p>
      {error ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 mg-type-caption text-health-down"
        >
          {error}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onSignIn}
        disabled={signingIn}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
      >
        {signingIn ? "Signing in…" : "Sign in with wallet"}
      </button>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded border border-health-down/30 bg-health-down/5 p-3 mg-type-caption text-health-down"
    >
      {message}
    </div>
  );
}

function AlertsPanel({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const queryKey = ["watch-triggers", token];
  const listQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<OwnerAlertTriggerView[]> => {
      const res = await apiFetch<{ triggers: OwnerAlertTriggerView[] }>("/api/v1/watch/triggers", {
        init: { headers: watchHeaders(token) },
      });
      return res.data.triggers;
    },
  });

  const triggers = listQuery.data ?? [];

  return (
    <div className="space-y-4">
      {/* #8385: device management for the webpush channel, inside the
          already-verified panel so the T6 token is reused, not re-issued. */}
      <PushDevicesManager token={token} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mg-type-caption text-ink-muted">
          {triggers.length} alert{triggers.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong hover:border-ink/30"
        >
          Sign out
        </button>
      </div>

      {listQuery.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {listQuery.isError ? <ErrorPanel message={describeApiError(listQuery.error)} /> : null}
      {!listQuery.isPending && !listQuery.isError && triggers.length === 0 ? (
        <AlertsEmptyState />
      ) : null}

      <div className="space-y-2">
        {triggers.map((trigger) => (
          <TriggerRow key={trigger.id} trigger={trigger} token={token} listQueryKey={queryKey} />
        ))}
      </div>
    </div>
  );
}

/** #8375 requirement 4: no triggers -> the two entry points as links, not prose. */
function AlertsEmptyState() {
  return (
    <div className="rounded border border-dashed border-ink-subtle bg-surface/30 p-6 text-center space-y-3">
      <div className="font-display text-sm font-medium text-ink-strong">No alerts yet</div>
      <p className="mg-type-caption text-ink-muted max-w-md mx-auto">
        Watch a subnet or a validator to get pinged the moment something changes.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Link
          to="/subnets"
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 mg-type-caption font-medium text-ink-strong hover:border-ink/30"
        >
          Watch a subnet
        </Link>
        <Link
          to="/validators"
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 mg-type-caption font-medium text-ink-strong hover:border-ink/30"
        >
          Watch a validator
        </Link>
      </div>
    </div>
  );
}

function TriggerEntityChip({ trigger }: { trigger: OwnerAlertTriggerView }) {
  if (trigger.netuid != null) {
    return (
      <Link
        to="/subnets/$netuid"
        params={{ netuid: trigger.netuid }}
        className="inline-flex shrink-0 items-center rounded-full border border-border bg-paper px-2 py-0.5 mg-type-micro text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
      >
        SN{trigger.netuid}
      </Link>
    );
  }
  if (trigger.account) {
    return (
      <Link
        to="/accounts/$ss58"
        params={{ ss58: trigger.account }}
        className="inline-flex shrink-0 items-center rounded-full border border-border bg-paper px-2 py-0.5 mg-type-micro text-ink-muted transition-colors hover:border-accent/40 hover:text-accent"
      >
        account
      </Link>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-paper px-2 py-0.5 mg-type-micro text-ink-muted">
      network-wide
    </span>
  );
}

function ChannelBadge({ channel }: { channel: OwnerAlertTriggerView["channel"] }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border bg-card px-1.5 py-0.5 mg-type-caption uppercase text-ink-muted">
      {channel}
    </span>
  );
}

function LastDeliveryPill({
  delivery,
  isLoading,
}: {
  delivery: DeliveryRecordView | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <span className="mg-type-caption-sm text-ink-muted">…</span>;
  }
  if (!delivery) {
    return <span className="mg-type-caption-sm text-ink-muted">no deliveries yet</span>;
  }
  return (
    <span
      className={classNames(
        "mg-type-caption-sm",
        delivery.success ? "text-health-ok" : "text-health-down",
      )}
      title={delivery.status_code != null ? `HTTP ${delivery.status_code}` : undefined}
    >
      {delivery.success ? "delivered" : "failed"}{" "}
      <TimeAgo at={epochMsToIso(delivery.delivered_at)} />
    </span>
  );
}

function DeliveryHistory({
  deliveries,
  isPending,
  isError,
  error,
}: {
  deliveries: DeliveryRecordView[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (isPending) return <Skeleton className="h-10 w-full" />;
  if (isError) return <ErrorPanel message={describeApiError(error)} />;
  if (deliveries.length === 0) {
    return (
      <p className="mg-type-caption text-ink-muted px-1 py-2">
        No deliveries recorded yet -- this trigger hasn't matched a live event since it was created.
      </p>
    );
  }
  return (
    <ul className="space-y-1 px-1 py-2">
      {deliveries.map((d) => (
        <li
          key={d.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-card px-2 py-1 mg-type-caption-sm"
        >
          <span className={d.success ? "text-health-ok" : "text-health-down"}>
            {d.success ? "ok" : "failed"}
          </span>
          <span className="text-ink-muted">
            <TimeAgo at={epochMsToIso(d.delivered_at)} />
          </span>
          {d.status_code != null ? (
            <span className="font-mono text-ink-muted">HTTP {d.status_code}</span>
          ) : null}
          {d.retry_count > 0 ? (
            <span className="text-ink-muted">{d.retry_count} retries</span>
          ) : null}
          {!d.success && d.response_snippet ? (
            <span className="w-full truncate text-ink-muted" title={d.response_snippet}>
              {d.response_snippet}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TriggerRow({
  trigger,
  token,
  listQueryKey,
}: {
  trigger: OwnerAlertTriggerView;
  token: string;
  listQueryKey: unknown[];
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [destinationInput, setDestinationInput] = useState(trigger.destination);

  const deliveriesQueryKey = ["watch-trigger-deliveries", trigger.id, token];
  const deliveriesQuery = useQuery({
    queryKey: deliveriesQueryKey,
    queryFn: async (): Promise<DeliveryRecordView[]> => {
      const res = await apiFetch<{ deliveries: DeliveryRecordView[] }>(
        `/api/v1/watch/triggers/${encodeURIComponent(trigger.id)}/deliveries`,
        { init: { headers: watchHeaders(token) } },
      );
      return res.data.deliveries;
    },
  });
  const deliveries = deliveriesQuery.data ?? [];

  function invalidateList() {
    queryClient.invalidateQueries({ queryKey: listQueryKey });
  }

  const toggleActiveMutation = useMutation({
    mutationFn: async (): Promise<OwnerAlertTriggerView> => {
      const res = await apiFetch<OwnerAlertTriggerView>(
        `/api/v1/watch/triggers/${encodeURIComponent(trigger.id)}`,
        {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json", ...watchHeaders(token) },
            body: JSON.stringify({ active: !trigger.active }),
          },
        },
      );
      return res.data;
    },
    onSuccess: invalidateList,
  });

  const editDestinationMutation = useMutation({
    mutationFn: async (destination: string): Promise<OwnerAlertTriggerView> => {
      const res = await apiFetch<OwnerAlertTriggerView>(
        `/api/v1/watch/triggers/${encodeURIComponent(trigger.id)}`,
        {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json", ...watchHeaders(token) },
            body: JSON.stringify({ destination }),
          },
        },
      );
      return res.data;
    },
    onSuccess: () => {
      invalidateList();
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      await apiFetch(`/api/v1/watch/triggers/${encodeURIComponent(trigger.id)}`, {
        init: { method: "DELETE", headers: watchHeaders(token) },
      });
    },
    onSuccess: invalidateList,
  });

  function onSubmitDestination(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = destinationInput.trim();
    if (!trimmed) return;
    editDestinationMutation.mutate(trimmed);
  }

  return (
    <div className="rounded border border-border bg-surface/40">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <TriggerEntityChip trigger={trigger} />
        <span className="min-w-0 flex-1 truncate mg-type-caption text-ink-strong">
          {trigger.name || summarizeTriggerFilter(trigger)}
        </span>
        <ChannelBadge channel={trigger.channel} />
        <span className="shrink-0 mg-type-caption-sm text-ink-muted">
          <TimeAgo at={epochMsToIso(trigger.created_at)} />
        </span>
        <LastDeliveryPill delivery={deliveries[0] ?? null} isLoading={deliveriesQuery.isPending} />
        {!trigger.active ? (
          <span className="shrink-0 rounded border border-health-warn/30 bg-health-warn/10 px-1.5 py-0.5 mg-type-caption text-health-warn">
            paused
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => toggleActiveMutation.mutate()}
            disabled={toggleActiveMutation.isPending}
            className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong hover:border-ink/30 disabled:opacity-50"
          >
            {trigger.active ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong hover:border-ink/30"
          >
            Edit
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="rounded border border-health-down/40 bg-health-down/5 px-2 py-1 mg-type-caption font-medium text-health-down hover:bg-health-down/10 disabled:opacity-50"
              >
                {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-health-down hover:border-health-down/40"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong hover:border-ink/30"
          >
            {expanded ? "Hide history" : "History"}
          </button>
        </div>
      </div>

      {editing ? (
        <form
          onSubmit={onSubmitDestination}
          className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5"
        >
          <span className="mg-type-caption text-ink-muted">Delivery destination</span>
          <input
            value={destinationInput}
            onChange={(e) => setDestinationInput(e.target.value)}
            className={classNames(inputCls, "flex-1 min-w-[16rem] font-mono")}
          />
          <button
            type="submit"
            disabled={editDestinationMutation.isPending}
            className="rounded border border-accent/40 bg-primary-soft px-2.5 py-1 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
          >
            {editDestinationMutation.isPending ? "Saving…" : "Save"}
          </button>
          {editDestinationMutation.isError ? (
            <div className="w-full">
              <ErrorPanel message={describeApiError(editDestinationMutation.error)} />
            </div>
          ) : null}
        </form>
      ) : null}

      {toggleActiveMutation.isError ? (
        <div className="border-t border-border px-3 py-2">
          <ErrorPanel message={describeApiError(toggleActiveMutation.error)} />
        </div>
      ) : null}
      {deleteMutation.isError ? (
        <div className="border-t border-border px-3 py-2">
          <ErrorPanel message={describeApiError(deleteMutation.error)} />
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t border-border">
          <DeliveryHistory
            deliveries={deliveries}
            isPending={deliveriesQuery.isPending}
            isError={deliveriesQuery.isError}
            error={deliveriesQuery.error}
          />
        </div>
      ) : null}
    </div>
  );
}
