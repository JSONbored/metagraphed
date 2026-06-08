import { Link } from "@tanstack/react-router";
import { HealthDot } from "./chips";
import { TimeAgo } from "./time-ago";
import type { Endpoint } from "@/lib/metagraphed/types";

/**
 * Endpoint list with desktop table + mobile stacked cards. Filters/sorts are
 * controlled by the caller; this component renders rows only.
 */
export function EndpointList({
  rows,
  showNetuid = false,
  showProvider = true,
}: {
  rows: Endpoint[];
  showNetuid?: boolean;
  showProvider?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
              <tr>
                {showNetuid ? <th className="px-3 py-2 text-left">Netuid</th> : null}
                <th className="px-3 py-2 text-left">Kind</th>
                <th className="px-3 py-2 text-left">URL</th>
                {showProvider ? <th className="px-3 py-2 text-left">Provider</th> : null}
                <th className="px-3 py-2 text-center">Health</th>
                <th className="px-3 py-2 text-right">Latency</th>
                <th className="px-3 py-2 text-right">Probed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => (
                <tr key={e.id} className="mg-row-hover">
                  {showNetuid ? (
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                      {e.netuid != null ? (
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: String(e.netuid) }}
                          className="hover:text-ink-strong"
                        >
                          {String(e.netuid).padStart(3, "0")}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 font-mono text-[11px]">{e.kind ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[36ch]">
                    {e.url ?? "—"}
                  </td>
                  {showProvider ? (
                    <td className="px-3 py-2 text-[12px]">
                      {e.provider ? (
                        <Link
                          to="/providers/$slug"
                          params={{ slug: e.provider_slug ?? e.provider }}
                          className="hover:text-ink-strong"
                        >
                          {e.provider}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-center">
                    <span className="inline-flex justify-center">
                      <HealthDot state={e.health} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                    {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-muted">
                    <TimeAgo at={e.last_probed_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile stacked cards */}
      <ul className="md:hidden space-y-2">
        {rows.map((e) => (
          <li
            key={e.id}
            className="rounded-lg border border-border bg-card p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {e.kind ?? "endpoint"}
                  </span>
                  {showNetuid && e.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: String(e.netuid) }}
                      className="font-mono text-[10px] text-ink-muted hover:text-ink-strong"
                    >
                      sn{String(e.netuid).padStart(3, "0")}
                    </Link>
                  ) : null}
                </div>
                <div className="font-mono text-[11px] text-ink break-all">
                  {e.url ?? "—"}
                </div>
              </div>
              <HealthDot state={e.health} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
              {showProvider ? (
                <>
                  <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    Provider
                  </dt>
                  <dd className="text-right">
                    {e.provider ? (
                      <Link
                        to="/providers/$slug"
                        params={{ slug: e.provider_slug ?? e.provider }}
                        className="hover:text-ink-strong"
                      >
                        {e.provider}
                      </Link>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </dd>
                </>
              ) : null}
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Latency
              </dt>
              <dd className="text-right font-mono text-ink">
                {e.latency_ms != null ? `${e.latency_ms}ms` : "—"}
              </dd>
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Probed
              </dt>
              <dd className="text-right font-mono text-ink-muted">
                <TimeAgo at={e.last_probed_at} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
