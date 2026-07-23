import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { domainsQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { BrandIcon } from "@jsonbored/ui-kit";
import type { Domain, Subnet } from "@/lib/metagraphed/types";

// #6996: the per-domain rollup over the 14-tag capability taxonomy
// (/api/v1/domains). Each domain is an expandable row — the collapsed row
// carries the headline rollup (member count, total stake, emission share,
// concentration), and expanding it reveals the full within-domain concentration
// breakdown plus every member subnet, each linking through to its detail page.

const pct = (v: number | undefined) => (v != null ? `${(v * 100).toFixed(2)}%` : "—");
const ratio = (v: number | undefined) => (v != null ? v.toFixed(3) : "—");

export function DomainsRollup() {
  const { data: domRes } = useSuspenseQuery(domainsQuery());
  const { data: snRes } = useSuspenseQuery(subnetsQuery());

  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);

  // Rank by emission share (the "where is the weight" signal), then by member
  // count, so the most significant domains lead.
  const domains = useMemo(
    () =>
      [...(domRes.data ?? [])].sort(
        (a, b) =>
          (b.total_emission_share ?? -1) - (a.total_emission_share ?? -1) ||
          b.subnet_count - a.subnet_count ||
          a.domain.localeCompare(b.domain),
      ),
    [domRes],
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section id="domains-rollup" className="scroll-mt-24">
      <div className="hidden grid-cols-[1.4fr_0.7fr_1fr_0.9fr_1fr] gap-2 border-b border-border px-4 pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted md:grid">
        <span>Domain</span>
        <span className="text-right">Subnets</span>
        <span className="text-right">Total stake</span>
        <span className="text-right">Emission</span>
        <span className="text-right">Nakamoto · Gini</span>
      </div>
      <ul className="divide-y divide-border">
        {domains.map((domain) => (
          <DomainRow
            key={domain.domain}
            domain={domain}
            subnetById={subnetById}
            open={expanded === domain.domain}
            onToggle={() => setExpanded((cur) => (cur === domain.domain ? null : domain.domain))}
          />
        ))}
      </ul>
    </section>
  );
}

function DomainRow({
  domain,
  subnetById,
  open,
  onToggle,
}: {
  domain: Domain;
  subnetById: Map<number, Subnet>;
  open: boolean;
  onToggle: () => void;
}) {
  const c = domain.emission_concentration;
  const panelId = `domain-detail-${domain.domain}`;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="mg-row-hover grid w-full grid-cols-[1fr_auto] items-center gap-2 px-4 py-3 text-left md:grid-cols-[1.4fr_0.7fr_1fr_0.9fr_1fr]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={`size-4 shrink-0 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
          <span className="truncate font-medium capitalize text-ink-strong">{domain.domain}</span>
        </span>
        <span className="font-mono text-xs tabular-nums text-ink-muted md:hidden">
          {domain.subnet_count} · {pct(domain.total_emission_share)}
        </span>
        <span className="hidden text-right font-mono text-sm tabular-nums text-ink-strong md:block">
          {domain.subnet_count}
        </span>
        <span className="hidden text-right font-mono text-sm tabular-nums text-ink-strong md:block">
          {formatTao(domain.total_stake_tao)}
        </span>
        <span className="hidden text-right font-mono text-sm tabular-nums text-ink-strong md:block">
          {pct(domain.total_emission_share)}
        </span>
        <span className="hidden text-right font-mono text-sm tabular-nums text-ink-muted md:block">
          {formatNumber(c?.nakamoto_coefficient)} · {ratio(c?.gini)}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="space-y-4 px-4 pb-4 pt-1">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Metric label="Total stake" value={formatTao(domain.total_stake_tao)} />
            <Metric label="Emission share" value={pct(domain.total_emission_share)} />
            <Metric label="Nakamoto coeff." value={formatNumber(c?.nakamoto_coefficient)} />
            <Metric label="Gini" value={ratio(c?.gini)} />
            <Metric label="HHI (normalized)" value={ratio(c?.hhi_normalized)} />
            <Metric label="Top-10% share" value={pct(c?.top_10pct_share)} />
            <Metric label="Top-20% share" value={pct(c?.top_20pct_share)} />
            <Metric label="Entropy (normalized)" value={ratio(c?.entropy_normalized)} />
          </dl>
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              {domain.subnet_count} member subnet{domain.subnet_count === 1 ? "" : "s"}
            </div>
            <div className="flex flex-wrap gap-2">
              {domain.netuids.map((netuid) => {
                const sn = subnetById.get(netuid);
                const name = sn?.name ?? `Subnet ${netuid}`;
                return (
                  <Link
                    key={netuid}
                    to="/subnets/$netuid"
                    params={{ netuid }}
                    className="mg-chip inline-flex items-center gap-1.5"
                  >
                    <BrandIcon
                      size={16}
                      name={name}
                      fallback={netuid}
                      netuid={netuid}
                      subnetSlug={sn?.slug}
                    />
                    <span className="truncate text-xs text-ink-strong">{name}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-ink-strong">{value}</div>
    </div>
  );
}
