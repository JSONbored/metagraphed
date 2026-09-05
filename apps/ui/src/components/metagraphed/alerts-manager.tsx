import { useRef, useState, type FormEvent, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { PushDevicesManager } from "@/components/metagraphed/push-devices-manager";
import { classNames } from "@/lib/metagraphed/format";
import { DataTable, TimeAgo, type DataTableColumn } from "@jsonbored/ui-kit";
import { ErrorState, Skeleton } from "@/components/metagraphed/states";
import { useWallet } from "@/hooks/use-wallet";
import { useWatchToken } from "@/hooks/use-watch-token";
import { WalletConnectPrompt } from "@/components/metagraphed/wallet-connect";

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
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-13 text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

export function AlertsManager() {
  const { wallet, status: walletStatus } = useWallet();
  const watchToken = useWatchToken(wallet);
  const connectedFocusRef = useRef<HTMLElement | null>(null);

  return (
    // No `SectionHead` and no `<section>` of its own: /settings wraps each
    // manager in an `AnalyticsSection` now (#11627), and two headings for one
    // list is exactly the doubling that rebuild removes.
    <>
      {walletStatus !== "connected" || !wallet ? (
        <WalletConnectPrompt
          description="Connect your wallet to manage alerts. You can then sign a message to verify your address."
          returnFocusRef={connectedFocusRef}
        />
      ) : watchToken.status === "active" && watchToken.token ? (
        <div
          ref={(element) => {
            connectedFocusRef.current = element;
          }}
          tabIndex={-1}
          role="group"
          aria-label="Alert management"
        >
          <AlertsPanel token={watchToken.token} onSignOut={watchToken.clear} />
        </div>
      ) : (
        <AlertsSignInPrompt
          focusRef={connectedFocusRef}
          signingIn={watchToken.status === "issuing"}
          error={watchToken.error}
          onSignIn={watchToken.issue}
        />
      )}
    </>
  );
}

function AlertsSignInPrompt({
  focusRef,
  signingIn,
  error,
  onSignIn,
}: {
  focusRef: RefObject<HTMLElement | null>;
  signingIn: boolean;
  error: string | null;
  onSignIn: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-13 text-ink-muted">
        Sign a one-time message with your connected wallet to view and manage the alert triggers you
        created with it. This never constructs or broadcasts a transaction -- it only proves you
        control this address.
      </p>
      {error ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 text-13 text-health-down"
        >
          {error}
        </div>
      ) : null}
      <button
        ref={(element) => {
          focusRef.current = element;
        }}
        type="button"
        onClick={onSignIn}
        disabled={signingIn}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-13 font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
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
      className="rounded border border-health-down/30 bg-health-down/5 p-3 text-13 text-health-down"
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
    retry: 0,
  });

  const triggers = listQuery.data ?? [];

  const columns: DataTableColumn<OwnerAlertTriggerView>[] = [
    {
      key: "name",
      label: "Trigger",
      render: (t) => (
        <span className="text-13 text-ink-strong">{t.name || summarizeTriggerFilter(t)}</span>
      ),
      value: (t) => t.name || summarizeTriggerFilter(t),
    },
    {
      key: "scope",
      label: "Scope",
      render: (t) => <TriggerEntityChip trigger={t} />,
      value: (t) => (t.netuid != null ? `SN${t.netuid}` : t.account ? "account" : "network-wide"),
    },
    { key: "channel", label: "Channel", value: (t) => t.channel },
    {
      key: "matches",
      label: "Matches",
      kind: "number",
      align: "right",
      value: (t) => t.match_count,
    },
    {
      key: "last_matched",
      label: "Last match",
      kind: "time",
      value: (t) => epochMsToIso(t.last_matched_at),
    },
    {
      key: "state",
      label: "State",
      kind: "status",
      value: (t) => (t.active ? "active" : "paused"),
    },
    {
      key: "destination",
      label: "Destination",
      kind: "identifier",
      demote: true,
      value: (t) => t.destination,
    },
    {
      key: "created",
      label: "Created",
      kind: "time",
      demote: true,
      value: (t) => epochMsToIso(t.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* #8385: device management for the webpush channel, inside the
          already-verified panel so the T6 token is reused, not re-issued. */}
      <PushDevicesManager token={token} />

      <DataTable
        caption="Alert triggers"
        rows={triggers}
        columns={columns}
        rowKey={(t) => t.id}
        source="alerts"
        storageKey="mg.alerts.columns"
        loading={listQuery.isPending}
        error={
          listQuery.isError ? (
            <ErrorState
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
              context="alert triggers"
            />
          ) : undefined
        }
        empty={<AlertsEmptyState />}
        // Every trigger has controls and a delivery log, so every row expands
        // -- the pause / edit / delete cluster that used to sit in each row's
        // right margin lives under the row now, which is what took the list
        // from five competing controls per line to one.
        expand={(t) => <TriggerControls trigger={t} token={token} listQueryKey={queryKey} />}
        filters={
          <button
            type="button"
            onClick={onSignOut}
            className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-ink-strong hover:border-ink/30"
          >
            Sign out
          </button>
        }
      />
    </div>
  );
}

/** #8375 requirement 4: no triggers -> the two entry points as links, not prose. */
function AlertsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <div className="text-13 text-ink-strong">No alerts yet</div>
      <p className="text-13 text-ink-muted">
        Watch a subnet or a validator to get pinged the moment something changes.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Link
          to="/subnets"
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 text-ink-strong hover:border-ink/30"
        >
          Watch a subnet
        </Link>
        <Link
          to="/validators"
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 text-ink-strong hover:border-ink/30"
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
        className="text-13 text-ink-muted hover:text-accent"
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
        className="text-13 text-ink-muted hover:text-accent"
      >
        account
      </Link>
    );
  }
  return <span className="text-13 text-ink-muted">network-wide</span>;
}

function DeliveryHistory({
  deliveries,
  isPending,
  isError,
  error,
  onRetry,
}: {
  deliveries: DeliveryRecordView[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (isPending) return <Skeleton className="h-10 w-full" />;
  if (isError) {
    return <ErrorState error={error} onRetry={onRetry} context="alert deliveries" />;
  }
  if (deliveries.length === 0) {
    return (
      <p className="text-13 text-ink-muted">
        No deliveries recorded yet -- this trigger hasn't matched a live event since it was created.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {deliveries.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-2 text-11">
          <span className={d.success ? "text-health-ok" : "text-health-down"}>
            {d.success ? "ok" : "failed"}
          </span>
          <span className="text-ink-muted">
            <TimeAgo at={epochMsToIso(d.delivered_at)} />
          </span>
          {d.status_code != null ? (
            <span className="text-ink-muted">HTTP {d.status_code}</span>
          ) : null}
          {d.retry_count > 0 ? (
            <span className="text-ink-muted">{d.retry_count} retries</span>
          ) : null}
          {!d.success && d.response_snippet ? (
            <span className="w-full truncate text-ink-muted">{d.response_snippet}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything you can do to one trigger, under the row rather than inside it.
 *
 * The deliveries query lives here, so it only runs for the trigger the reader
 * opened -- the old row fired one per trigger on mount to paint a "delivered
 * 3h ago" pill, which is `match_count` and `last_matched_at` on the trigger
 * itself, two columns that cost nothing.
 */
function TriggerControls({
  trigger,
  token,
  listQueryKey,
}: {
  trigger: OwnerAlertTriggerView;
  token: string;
  listQueryKey: unknown[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [destinationInput, setDestinationInput] = useState(trigger.destination);

  const deliveriesQuery = useQuery({
    queryKey: ["watch-trigger-deliveries", trigger.id, token],
    queryFn: async (): Promise<DeliveryRecordView[]> => {
      const res = await apiFetch<{ deliveries: DeliveryRecordView[] }>(
        `/api/v1/watch/triggers/${encodeURIComponent(trigger.id)}/deliveries`,
        { init: { headers: watchHeaders(token) } },
      );
      return res.data.deliveries;
    },
    retry: 0,
  });

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggleActiveMutation.mutate()}
          disabled={toggleActiveMutation.isPending}
          className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-ink-strong hover:border-ink/30 disabled:opacity-50"
        >
          {trigger.active ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-ink-strong hover:border-ink/30"
        >
          Edit destination
        </button>
        {confirmingDelete ? (
          <>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded border border-health-down/40 bg-health-down/5 px-2 py-1 text-13 text-health-down hover:bg-health-down/10 disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-ink-strong"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-health-down hover:border-health-down/40"
          >
            Delete
          </button>
        )}
      </div>

      {editing ? (
        <form onSubmit={onSubmitDestination} className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-muted">Delivery destination</span>
          <input
            value={destinationInput}
            onChange={(e) => setDestinationInput(e.target.value)}
            className={classNames(inputCls, "flex-1")}
          />
          <button
            type="submit"
            disabled={editDestinationMutation.isPending}
            className="rounded border border-accent/40 bg-primary-soft px-2.5 py-1 text-13 text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
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
        <ErrorPanel message={describeApiError(toggleActiveMutation.error)} />
      ) : null}
      {deleteMutation.isError ? (
        <ErrorPanel message={describeApiError(deleteMutation.error)} />
      ) : null}

      <DeliveryHistory
        deliveries={deliveriesQuery.data ?? []}
        isPending={deliveriesQuery.isPending}
        isError={deliveriesQuery.isError}
        error={deliveriesQuery.error}
        onRetry={() => void deliveriesQuery.refetch()}
      />
    </div>
  );
}
