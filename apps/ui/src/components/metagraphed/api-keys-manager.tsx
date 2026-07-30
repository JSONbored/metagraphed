import {} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { SectionHeading, CopyableCode, BarMini } from "@jsonbored/ui-kit";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useWallet } from "@/hooks/use-wallet";
import { useApiSession } from "@/hooks/use-api-session";

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

function formatTimestamp(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString();
}

/**
 * Self-serve fullnode/freemium API key management -- wallet-signature login
 * (use-api-session.ts), then generate/list/revoke against /api/v1/keys.
 * No invite code: every wallet-connected account mints at its own tier
 * immediately. Tier changes are an operator action, not something this UI
 * exposes -- see workers/data-api.ts's handleAccountTierPromote.
 */
export function ApiKeysManager() {
  const { wallet, status: walletStatus } = useWallet();
  const apiSession = useApiSession(wallet);

  return (
    <section aria-labelledby="api-keys-heading">
      <SectionHeading
        id="api-keys-heading"
        title="API keys"
        intro="Real fullnode RPC access, plus a higher rate-limit tier on the general API (currently: the chain-events/deep-history routes, more to follow). The keyless API keeps working exactly as-is -- a key buys headroom, it never gates the base. Requires a wallet-signed login; no invite code."
      />
      <Panel as="div" dense>
        {walletStatus !== "connected" || !wallet ? (
          <EmptyState
            title="Connect your wallet"
            description="Connect a wallet from the header above to sign in and manage your API keys."
          />
        ) : apiSession.status === "active" && apiSession.token ? (
          <ApiKeysPanel
            token={apiSession.token}
            tier={apiSession.tier}
            onSignOut={apiSession.signOut}
          />
        ) : (
          <SignInPrompt
            signingIn={apiSession.status === "signing-in"}
            error={apiSession.error}
            onSignIn={apiSession.signIn}
          />
        )}
      </Panel>
    </section>
  );
}

function SignInPrompt({
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
        Sign a one-time message with your connected wallet to manage your API keys. This never
        constructs or broadcasts a transaction -- it only proves you control this address.
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
  });
  const blockStatus = statusQuery.data;

  return (
    <div className="space-y-4">
      {blockStatus?.blocked ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 p-3 space-y-1"
        >
          <p className="mg-type-caption font-medium text-health-down">
            API access is currently blocked
          </p>
          <p className="mg-type-caption text-ink-muted">{blockStatus.message}</p>
          <p className="mg-type-caption text-ink-subtle">
            Reason code <span className="font-mono text-ink-muted">{blockStatus.reason_code}</span>.
            Existing keys stay listed below but will be refused until the block is lifted.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mg-type-caption text-ink-muted">
          Tier: <span className="font-mono text-ink-strong">{tier ?? "free"}</span>
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded border border-border bg-card px-2 py-1 mg-type-caption text-ink-muted hover:text-ink-strong hover:border-ink/30"
        >
          Sign out
        </button>
      </div>

      <button
        type="button"
        onClick={() => createMutation.mutate()}
        disabled={createMutation.isPending}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
      >
        {createMutation.isPending ? "Generating…" : "Generate new key"}
      </button>

      {createMutation.isError ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 p-3 mg-type-caption text-health-down"
        >
          {describeApiError(createMutation.error)}
        </div>
      ) : null}

      {createMutation.data ? (
        <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="mg-type-caption font-medium text-health-warn">
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
        {listQuery.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {listQuery.isError ? (
          <div
            role="alert"
            className="rounded border border-health-down/30 bg-health-down/5 p-3 mg-type-caption text-health-down"
          >
            {describeApiError(listQuery.error)}
          </div>
        ) : null}
        {!listQuery.isPending && !listQuery.isError && activeKeys.length === 0 ? (
          <EmptyState title="No active keys" description="Generate one above to get started." />
        ) : null}
        {activeKeys.map((key) => (
          <div
            key={key.key_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface/40 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="font-mono mg-type-caption text-ink-strong truncate">{key.key_id}</div>
              <div className="mg-type-caption text-ink-muted">
                Created {formatTimestamp(key.created_at)} · Last used{" "}
                {formatTimestamp(key.last_used_at)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => revokeMutation.mutate(key.key_id)}
              disabled={revokeMutation.isPending && revokeMutation.variables === key.key_id}
              className="shrink-0 rounded border border-health-down/40 bg-health-down/5 px-2 py-1 mg-type-caption font-medium text-health-down hover:bg-health-down/10 disabled:opacity-50"
            >
              {revokeMutation.isPending && revokeMutation.variables === key.key_id
                ? "Revoking…"
                : "Revoke"}
            </button>
          </div>
        ))}
      </div>

      {activeKeys.length > 0 ? <UsageDashboard usage={usageQuery.data} token={token} /> : null}
    </div>
  );
}

/**
 * Last 7d of this account's tiered-API usage (#8386) -- combined across every
 * active key on the account (api_key_usage_daily is recorded per-account, not
 * per-key; see workers/data-api.ts's handleAccountKeyUsage). Renders nothing
 * while loading or on a genuinely empty window (a brand-new key with no
 * requests yet) -- there's nothing meaningful to show either way, and an
 * empty-chart placeholder would just be noise under the key list above it.
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

function UsageDashboard({ usage, token }: { usage: ApiKeyUsage | undefined; token: string }) {
  if (!usage || usage.days.length === 0) return null;
  const chronological = [...usage.days].reverse();
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
        <p className="mg-type-caption font-medium text-ink-strong">
          Usage, last {usage.window_days}d
        </p>
        <button
          type="button"
          onClick={() => void exportUsageCsv(token)}
          className="mg-type-caption text-ink-muted underline hover:text-ink-strong"
        >
          Export CSV
        </button>
      </div>

      {quota ? (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 mg-type-caption">
            <span className="text-ink-muted">Daily quota</span>
            <span className="font-mono text-ink-strong">
              {quota.units_spent.toLocaleString()} / {quota.daily_units.toLocaleString()} units
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
                  ? "h-full bg-health-down"
                  : usedPct >= 70
                    ? "h-full bg-health-warn"
                    : "h-full bg-accent"
              }
              style={{ width: `${usedPct}%` }}
            />
          </div>
          <p className="mg-type-caption text-ink-subtle">
            {quota.remaining.toLocaleString()} units left · resets{" "}
            {new Date(quota.resets_at).toLocaleTimeString(undefined, {
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
        <p className="mg-type-caption text-ink-subtle">
          No daily quota on the <span className="font-mono">{usage.tier ?? "free"}</span> tier —
          only the per-minute limit applies.
        </p>
      )}

      {usage.rejected_total > 0 ? (
        <p className="mg-type-caption text-health-warn">
          {usage.rejected_total.toLocaleString()} request
          {usage.rejected_total === 1 ? " was" : "s were"} rate-limited in this window. Rate-limited
          requests are not counted against your quota.
        </p>
      ) : null}

      <BarMini
        data={chronological.map((d) => ({
          label: new Date(d.day).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          value: d.count,
        }))}
        ariaLabel={`Daily request count, last ${usage.window_days} days`}
      />
      {usage.top_routes.length > 0 ? (
        <div>
          <p className="mg-type-caption text-ink-muted">Top routes</p>
          <ul className="mt-1 space-y-1">
            {usage.top_routes.map((r) => (
              <li
                key={r.route}
                className="flex items-center justify-between gap-2 mg-type-caption text-ink-muted"
              >
                <span className="font-mono text-ink-strong">{r.route}</span>
                <span>{r.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
