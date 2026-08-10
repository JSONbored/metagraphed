import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/metagraphed/client";
import { Panel } from "@/components/metagraphed/primitives";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";

/** Mirrors src/alert-triggers.ts. */
const OWNER_TOKEN_HEADER = "x-alert-trigger-owner-token";

interface TriggerView {
  id: string;
  channel: string;
  destination: string;
  active: boolean;
  netuid: number | null;
  event_kind: string | null;
  last_matched_at: string | null;
  match_count: number;
}

/**
 * `/api/v1/alerts/triggers/{id}` (#10300), published and rendered nowhere.
 *
 * The UI has always been able to CREATE a trigger — that is what the watch
 * forms do — and never to read one back. So a caller who created an alert had
 * no way to answer "is it still active, and has it ever fired", which is the
 * only question you have after setting one up.
 *
 * It needs the `owner_token` issued once at creation, and the route returns the
 * SAME 404 for a wrong token and a nonexistent id so it cannot be used to
 * enumerate other callers' triggers. The panel says that rather than guessing
 * which of the two happened — reporting "no such trigger" for a mistyped token
 * would send someone hunting for a trigger that exists.
 *
 * `last_matched_at` being null is DISTINCT from `match_count` of 0: one means
 * it has never fired, the other is the count. They agree today, and the panel
 * shows the count with its own "never fired" wording rather than deriving one
 * from the other.
 */
export function AlertTriggerLookup() {
  const [id, setId] = useState("");
  const [token, setToken] = useState("");

  const lookup = useMutation({
    mutationFn: async (vars: { id: string; token: string }): Promise<TriggerView> => {
      const res = await apiFetch<TriggerView>(
        `/api/v1/alerts/triggers/${encodeURIComponent(vars.id)}`,
        { init: { headers: { [OWNER_TOKEN_HEADER]: vars.token } } },
      );
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    lookup.mutate({ id: id.trim(), token: token.trim() });
  }

  const t = lookup.data;

  return (
    <Panel as="section" dense>
      <h3 className="mb-1 mg-type-label text-ink-muted">Look up a trigger</h3>
      <p className="mb-3 max-w-2xl mg-type-caption-lg text-ink-muted">
        Check whether an alert you created is still active and whether it has ever fired. Needs the
        owner token issued when it was created — it is shown once and never echoed back.
      </p>

      <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="trigger id"
          aria-label="Trigger id"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 mg-type-data-sm text-ink"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="owner token"
          aria-label="Owner token"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 mg-type-data-sm text-ink"
        />
        <button
          type="submit"
          disabled={lookup.isPending || !id.trim() || !token.trim()}
          className="rounded border border-border bg-card px-3 py-1 mg-type-caption font-medium text-ink-strong hover:border-accent/40 disabled:opacity-50"
        >
          {lookup.isPending ? "Looking up…" : "Look up"}
        </button>
      </form>

      {/* The route returns the SAME 404 either way, deliberately, so the panel
          must not pick one. Claiming "no such trigger" for a mistyped token
          would send someone hunting for a trigger that exists. */}
      {lookup.isError ? (
        <p className="mt-3 mg-type-data-sm text-ink-muted">
          No trigger matched — either the id does not exist or the token is wrong. The API returns
          the same answer for both on purpose, so that this cannot be used to discover other
          callers&rsquo; triggers.
        </p>
      ) : null}

      {t ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Detail label="state" value={t.active ? "active" : "paused"} />
          <Detail label="channel" value={`${t.channel}`} />
          <Detail
            label="watching"
            value={t.netuid == null ? (t.event_kind ?? "everything") : `SN${t.netuid}`}
          />
          <Detail
            label="fired"
            value={
              t.last_matched_at
                ? `${formatNumber(t.match_count)} · last ${formatRelative(t.last_matched_at)}`
                : "never"
            }
          />
        </dl>
      ) : null}
    </Panel>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="mg-type-label text-ink-muted">{label}</dt>
      <dd className="mg-type-data-sm text-ink">{value}</dd>
    </div>
  );
}
