import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { chainIdentityHistoryQuery } from "@/lib/metagraphed/queries";
import { EmptyState } from "@/components/metagraphed/states";
import { TimeAgo } from "@/components/metagraphed/time-ago";

// #3474: homepage widget — the live network-wide feed of recent subnet-identity
// changes (name / symbol / description / URL / logo edits observed on-chain),
// newest first, from the newly-wired chainIdentityHistoryQuery. Self-contained:
// fetches via useQuery and renders a compact feed list.

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

/**
 * Recent subnet-identity changes across the whole network, newest first — each
 * row links to its subnet, shows the current name/symbol, and when the change
 * was observed on-chain. Wraps the middle column in min-w-0 + truncate so long
 * names/descriptions never escape the row at mobile width.
 */
export function RecentIdentityChanges() {
  const { data: res, isPending } = useQuery(chainIdentityHistoryQuery(10));
  const changes = res?.data?.changes ?? [];

  if (isPending && !res) {
    return <Notice>Loading recent identity changes…</Notice>;
  }

  if (changes.length === 0) {
    return (
      <EmptyState
        title="No recent identity changes"
        description="Subnet identity edits (name, symbol, description, URL, logo) observed on-chain across every subnet appear here, newest first, once captured."
        lastChecked={res?.meta?.generated_at}
      />
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {changes.map((c) => (
        <li key={`${c.netuid}-${c.identity_hash}`} className="flex items-center gap-3 px-4 py-3">
          <Link
            to="/subnets/$netuid"
            params={{ netuid: c.netuid }}
            className="shrink-0 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:text-accent"
          >
            SN{c.netuid}
          </Link>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-ink-strong">
              {c.subnet_name ?? "—"}
              {c.symbol ? <span className="ml-1.5 text-ink-muted">({c.symbol})</span> : null}
            </div>
            {c.description ? (
              <div className="truncate font-mono text-[10px] text-ink-muted">{c.description}</div>
            ) : null}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-ink-muted">
            <TimeAgo at={c.observed_at} />
          </span>
        </li>
      ))}
    </ul>
  );
}
