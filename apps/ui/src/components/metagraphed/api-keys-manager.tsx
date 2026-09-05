import { useRef, type CSSProperties, type RefObject } from "react";
import { formatNumber } from "@/lib/metagraphed/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { CopyableCode, DataTable, LineWithWindow, type DataTableColumn } from "@jsonbored/ui-kit";
import { EmptyState, ErrorState, Skeleton } from "@/components/metagraphed/states";
import { useWallet } from "@/hooks/use-wallet";
import { useApiSession } from "@/hooks/use-api-session";
import { toLinePoints } from "@/components/metagraphed/metric-history";
import { WalletConnectPrompt } from "@/components/metagraphed/wallet-connect-button";

interface ApiKeyRow {
  key_id: string;
  tier: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

interface ApiKeyMinted {
  key: string;
  key_id: string;
  tier: string;
  created_at: number;
}

interface ApiKeyUsage {
  window_days: number;
  tier: string | null;
  // #8609: null when the tier has no daily cap. `free` is uncapped by design,
  // and rendering 0 or Infinity for it would both read as "you are at your
  // limit" — so the absence is modelled explicitly rather than defaulted.
  quota: {
    units_spent: number;
    daily_units: number;
    remaining: number;
    resets_at: string;
  } | null;
  days: { day: string; count: number; rejected: number }[];
  top_routes: { route: string; count: number; rejected: number }[];
  rejected_total: number;
}

// #8611. Mirrors GET /api/v1/keys/status. Deliberately has no `note` field:
// the internal note is written by a maintainer for maintainers and can name a
// person or a ticket, so the route never sends it and the client has nowhere
// to put it even by accident.
interface ApiKeyStatus {
  blocked: boolean;
  reason_code?: string;
  message?: string;
  blocked_at?: number;
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired -- sign in again.";
    if (error.status === 503) return error.message || "Not provisioned on this deployment.";
    if (error.status === 429) return "Too many requests -- slow down and try again.";
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

/**
 * Epoch millis as an ISO string, or null.
 *
 * `kind: "time"` renders a relative age from an ISO timestamp; this endpoint
 * publishes epoch millis, and handing the cell a raw number would print the
 * number. Null stays null so the cell falls to its own em-dash rather than to
 * the string "never", which sorts and exports as text.
 */
function isoFrom(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Self-serve fullnode/freemium API key management -- wallet-signature login
 * (use-api-session.ts), then generate/list/revoke against /api/v1/keys.
 * No invite code: every wallet-connected account mints at its own tier
 * immediately. Tier changes are an operator action, not something this UI
 * exposes -- see workers/data-api.ts's handleAccountTierPromote.
 */
/** The revoke control lives in the row it acts on, not behind a menu. */
function keyColumns(revoke: {
  mutate: (id: string) => void;
  isPending: boolean;
  variables?: string;
}): DataTableColumn<ApiKeyRow>[] {
  return [
    { key: "id", label: "Key", kind: "identifier", value: (key) => key.key_id },
    {
      key: "created",
      label: "Created",
      kind: "time",
      width: 140,
      value: (key) => isoFrom(key.created_at),
    },
    {
      key: "used",
      label: "Last used",
      kind: "time",
      width: 140,
      value: (key) => isoFrom(key.last_used_at),
    },
    {
      key: "revoke",
      label: "",
      width: 110,
      align: "right",
      render: (key) => (
        <button
          type="button"
          onClick={() => revoke.mutate(key.key_id)}
          disabled={revoke.isPending && revoke.variables === key.key_id}
          className="mg-section-more"
        >
          {revoke.isPending && revoke.variables === key.key_id ? "Revoking…" : "Revoke"}
        </button>
      ),
    },
  ];
}

export function ApiKeysManager() {
  const { wallet, status: walletStatus } = useWallet();
  const apiSession = useApiSession(wallet);
  const connectedFocusRef = useRef<HTMLElement | null>(null);

  // No `SectionHead` and no `<section>` of its own: /settings wraps each
  // manager in an `AnalyticsSection` now (#11627), and two headings for one
  // list is exactly the doubling that rebuild removes.
  return (
    <>
      <div className="min-w-0 mg-panel-pad">
        {walletStatus !== "connected" || !wallet ? (
          <WalletConnectPrompt
            description="Connect your wallet to manage API keys. You can then sign a message to sign in."
            returnFocusRef={connectedFocusRef}
          />
        ) : apiSession.status === "active" && apiSession.token ? (
          <div
            ref={(element) => {
              connectedFocusRef.current = element;
            }}
            tabIndex={-1}
            role="group"
            aria-label="API key management"
          >
            <ApiKeysPanel
              token={apiSession.token}
              tier={apiSession.tier}
              onSignOut={apiSession.signOut}
            />
          </div>
        ) : (
          <SignInPrompt
            focusRef={connectedFocusRef}
            signingIn={apiSession.status === "signing-in"}
            error={apiSession.error}
            onSignIn={apiSession.signIn}
          />
        )}
      </div>
    </>
  );
}

function SignInPrompt({
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
        Sign a one-time message with your connected wallet to manage your API keys. This never
        constructs or broadcasts a transaction -- it only proves you control this address.
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

function ApiKeysPanel({
  token,
  tier,
  onSignOut,
}: {
  token: string;
  tier: string | null;
  onSignOut: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["api-keys", token];

  const listQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<ApiKeyRow[]> => {
      const res = await apiFetch<{ keys: ApiKeyRow[] }>("/api/v1/keys", {
        init: { headers: authHeaders(token) },
      });
      return res.data.keys;
    },
    retry: 0,
  });

  const createMutation = useMutation({
    mutationFn: async (): Promise<ApiKeyMinted> => {
      const res = await apiFetch<ApiKeyMinted>("/api/v1/keys", {
        init: { method: "POST", headers: authHeaders(token) },
      });
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const revokeMutation = useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      await apiFetch(`/api/v1/keys/${encodeURIComponent(keyId)}`, {
        init: { method: "DELETE", headers: authHeaders(token) },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const keys = listQuery.data ?? [];
  const activeKeys = keys.filter((k) => !k.revoked_at);

  const usageQuery = useQuery({
    queryKey: ["api-keys-usage", token],
    queryFn: async (): Promise<ApiKeyUsage> => {
      const res = await apiFetch<ApiKeyUsage>("/api/v1/keys/usage", {
        init: { headers: authHeaders(token) },
      });
      return res.data;
    },
    enabled: activeKeys.length > 0,
    retry: 0,
  });

  // #8611: a blocked account must be able to see that it is blocked. Without
  // this the only symptom is every request failing with a 403 the dashboard
  // never explains, which turns a deliberate action into a mystery outage.
  // Runs regardless of whether any key exists -- the block is account-level.
  const statusQuery = useQuery({
    queryKey: ["api-keys-status", token],
    queryFn: async (): Promise<ApiKeyStatus> => {
      const res = await apiFetch<ApiKeyStatus>("/api/v1/keys/status", {
        init: { headers: authHeaders(token) },
      });
      return res.data;
    },
    retry: 0,
  });
  const blockStatus = statusQuery.data;

  return (
    <div className="space-y-4">
      {statusQuery.isError ? (
        <ErrorState
          error={statusQuery.error}
          onRetry={() => void statusQuery.refetch()}
          context="API access status"
        />
      ) : blockStatus?.blocked ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 p-3 space-y-1"
        >
          <p className="text-13 font-medium text-health-down">API access is currently blocked</p>
          <p className="text-13 text-ink-muted">{blockStatus.message}</p>
          <p className="text-13 text-ink-subtle">
            Reason code <span className="font-mono text-ink-muted">{blockStatus.reason_code}</span>.
            Existing keys stay listed below but will be refused until the block is lifted.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-13 text-ink-muted">
          Tier: <span className="font-mono text-ink-strong">{tier ?? "free"}</span>
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded border border-border bg-card px-2 py-1 text-13 text-ink-muted hover:text-ink-strong hover:border-ink/30"
        >
          Sign out
        </button>
      </div>

      <button
        type="button"
        onClick={() => createMutation.mutate()}
        disabled={createMutation.isPending}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-13 font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
      >
        {createMutation.isPending ? "Generating…" : "Generate new key"}
      </button>

      {createMutation.isError ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 p-3 text-13 text-health-down"
        >
          {describeApiError(createMutation.error)}
        </div>
      ) : null}

      {createMutation.data ? (
        <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="text-13 font-medium text-health-warn">
            This key is shown once and is never echoed back -- store it now.
          </p>
          {/* ph-no-capture: excludes this one-time secret reveal from
              PostHog session replay (metagraphed#7761) -- rrweb's own
              blockClass marker, see analytics.ts's session_recording config. */}
          <CopyableCode
            label="key"
            value={createMutation.data.key}
            truncate={false}
            className="w-full ph-no-capture"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <DataTable
          id="api-keys"
          rows={activeKeys}
          columns={keyColumns(revokeMutation)}
          rowKey={(key) => key.key_id}
          caption="Active keys"
          source="api-key"
          paginate={false}
          loading={listQuery.isPending}
          error={
            listQuery.isError ? (
              <ErrorState
                error={listQuery.error}
                onRetry={() => void listQuery.refetch()}
                context="active API keys"
              />
            ) : undefined
          }
          empty={
            !listQuery.isPending && !listQuery.isError ? (
              <EmptyState title="No active keys" description="Generate one above to get started." />
            ) : undefined
          }
        />
      </div>

      {activeKeys.length > 0 ? (
        <UsageDashboard
          usage={usageQuery.data}
          token={token}
          loading={usageQuery.isPending}
          error={usageQuery.isError ? usageQuery.error : null}
          onRetry={() => void usageQuery.refetch()}
        />
      ) : null}
    </div>
  );
}

/**
 * Last 7d of this account's tiered-API usage (#8386) -- combined across every
 * active key on the account (api_key_usage_daily is recorded per-account, not
 * per-key; see workers/data-api.ts's handleAccountKeyUsage). It keeps the
 * compact chart's footprint while loading and exposes a local retry if the
 * usage record fails. A genuinely empty window remains quiet for a brand-new
 * key with no requests yet.
 */
/**
 * Download the tenant's own usage as CSV (#8609).
 *
 * A fetch + blob rather than a plain `<a download href=...>`, because the route
 * authenticates with an `Authorization: Bearer` header and an anchor cannot set
 * one. The obvious workaround -- putting the session token in the query string
 * -- would leak a live credential into browser history, any intermediary's
 * access logs, and the Referer header of whatever the user visits next. A
 * short-lived object URL keeps it in memory and is revoked immediately.
 */
async function exportUsageCsv(token: string) {
  const res = await fetch("/api/v1/keys/usage?format=csv", {
    headers: authHeaders(token),
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `metagraphed-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function UsageDashboard({
  usage,
  token,
  loading,
  error,
  onRetry,
}: {
  usage: ApiKeyUsage | undefined;
  token: string;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3 border-t border-border pt-4" aria-busy="true">
        <div className="flex items-baseline justify-between gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
        <LineWithWindow
          compact
          loading
          points={[]}
          window={{ from: 0, to: 0 }}
          unit="requests per day"
          ariaLabel="Loading API-key usage"
          source="api-key-usage"
        />
      </div>
    );
  }
  if (error) {
    return <ErrorState error={error} onRetry={onRetry} context="API-key usage" />;
  }
  if (!usage || usage.days.length === 0) return null;
  const chronological = [...usage.days].reverse();
  const requestPoints = toLinePoints(
    chronological,
    (d) => d.day,
    (d) => d.count,
  );
  const quota = usage.quota;
  // Percent of the day's cost-unit budget consumed. Clamped at 100 because the
  // quota rejects a spend that would exceed the limit rather than letting it
  // overshoot, so a bar past 100% would depict something that cannot happen.
  const usedPct = quota
    ? Math.min(100, Math.round((quota.units_spent / quota.daily_units) * 100))
    : 0;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-13 font-medium text-ink-strong">Usage, last {usage.window_days}d</p>
        <button
          type="button"
          onClick={() => void exportUsageCsv(token)}
          className="text-13 text-ink-muted underline hover:text-ink-strong"
        >
          Export CSV
        </button>
      </div>

      {quota ? (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-13">
            <span className="text-ink-muted">Daily quota</span>
            <span className="font-mono text-ink-strong">
              {formatNumber(quota.units_spent)} / {formatNumber(quota.daily_units)} units
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded bg-border"
            role="meter"
            aria-valuenow={usedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Daily quota consumed"
          >
            <div
              className={
                usedPct >= 90
                  ? "mg-meter-fill bg-health-down"
                  : usedPct >= 70
                    ? "mg-meter-fill bg-health-warn"
                    : "mg-meter-fill bg-accent"
              }
              // The fill IS the datum, carried as a custom property (#11628).
              style={{ "--mg-fill": `${usedPct}%` } as CSSProperties}
            />
          </div>
          <p className="text-13 text-ink-subtle">
            {formatNumber(quota.remaining)} units left · resets{" "}
            {new Date(quota.resets_at).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              // The quota resets at 00:00 UTC and the label says UTC, so the
              // time must be rendered in UTC too. Without this the browser
              // formats in LOCAL time and the pair reads as a flat lie --
              // "resets 5:00 PM UTC" for a midnight-UTC reset.
              timeZone: "UTC",
            })}{" "}
            UTC
          </p>
        </div>
      ) : (
        <p className="text-13 text-ink-subtle">
          No daily quota on the <span className="font-mono">{usage.tier ?? "free"}</span> tier —
          only the per-minute limit applies.
        </p>
      )}

      {usage.rejected_total > 0 ? (
        <p className="text-13 text-health-warn">
          {formatNumber(usage.rejected_total)} request
          {usage.rejected_total === 1 ? " was" : "s were"} rate-limited in this window. Rate-limited
          requests are not counted against your quota.
        </p>
      ) : null}

      {requestPoints.length > 1 ? (
        <LineWithWindow
          compact
          points={requestPoints}
          window={{ from: requestPoints[0]!.t, to: requestPoints[requestPoints.length - 1]!.t }}
          unit="requests per day"
          formatValue={(v) => formatNumber(v)}
          ariaLabel={`Daily request count, last ${usage.window_days} days`}
          source="api-key-usage"
        />
      ) : null}
      {usage.top_routes.length > 0 ? (
        <div>
          <p className="text-13 text-ink-muted">Top routes</p>
          <ul className="mt-1 space-y-1">
            {usage.top_routes.map((r) => (
              <li
                key={r.route}
                className="flex items-center justify-between gap-2 text-13 text-ink-muted"
              >
                <span className="font-mono text-ink-strong">{r.route}</span>
                <span>{formatNumber(r.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
