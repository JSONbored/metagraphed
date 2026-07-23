import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { SectionHeading, CopyableCode } from "@jsonbored/ui-kit";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
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
 * exposes -- see workers/data-api.mjs's handleAccountTierPromote.
 */
export function ApiKeysManager() {
  const { wallet, status: walletStatus } = useWallet();
  const apiSession = useApiSession(wallet);

  return (
    <section aria-labelledby="api-keys-heading">
      <SectionHeading
        id="api-keys-heading"
        title="API keys"
        intro="Real fullnode RPC access -- not just the keyless read-only proxy. Requires a wallet-signed login; no invite code."
      />
      <div className="rounded border border-border bg-card p-4">
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
      </div>
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
      <p className="text-[12px] text-ink-muted">
        Sign a one-time message with your connected wallet to manage your API keys. This never
        constructs or broadcasts a transaction -- it only proves you control this address.
      </p>
      {error ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 text-[11px] text-health-down"
        >
          {error}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onSignIn}
        disabled={signingIn}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-ink-muted">
          Tier: <span className="font-mono text-ink-strong">{tier ?? "free"}</span>
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded border border-border bg-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink-strong hover:border-ink/30"
        >
          Sign out
        </button>
      </div>

      <button
        type="button"
        onClick={() => createMutation.mutate()}
        disabled={createMutation.isPending}
        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
      >
        {createMutation.isPending ? "Generating…" : "Generate new key"}
      </button>

      {createMutation.isError ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
        >
          {describeApiError(createMutation.error)}
        </div>
      ) : null}

      {createMutation.data ? (
        <div className="space-y-2 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="text-[12px] font-medium text-health-warn">
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
            className="rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
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
              <div className="font-mono text-[12px] text-ink-strong truncate">{key.key_id}</div>
              <div className="text-[10px] text-ink-muted">
                Created {formatTimestamp(key.created_at)} · Last used{" "}
                {formatTimestamp(key.last_used_at)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => revokeMutation.mutate(key.key_id)}
              disabled={revokeMutation.isPending && revokeMutation.variables === key.key_id}
              className="shrink-0 rounded border border-health-down/40 bg-health-down/5 px-2 py-1 text-[11px] font-medium text-health-down hover:bg-health-down/10 disabled:opacity-50"
            >
              {revokeMutation.isPending && revokeMutation.variables === key.key_id
                ? "Revoking…"
                : "Revoke"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
