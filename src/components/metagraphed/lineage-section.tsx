import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitMerge, ArrowRight } from "lucide-react";
import { lineageQuery } from "@/lib/metagraphed/queries";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";

export function LineageSection({ netuid }: { netuid: number }) {
  const { data } = useQuery(lineageQuery());
  const links = data?.data?.links ?? [];
  const link = links.find((l) => l.mainnet_netuid === netuid || l.testnet_netuid === netuid);
  if (!link) return null;

  const isMain = link.mainnet_netuid === netuid;
  const other = isMain
    ? {
        netuid: link.testnet_netuid,
        name: link.testnet_name,
        slug: link.testnet_slug,
        label: "Testnet",
      }
    : {
        netuid: link.mainnet_netuid,
        name: link.mainnet_name,
        slug: link.mainnet_slug,
        label: "Mainnet",
      };

  if (other.netuid == null) return null;

  return (
    <SectionAnchor
      id="lineage"
      title="Lineage"
      subtitle="Mainnet ↔ testnet pairing for this subnet."
      info="GET /api/v1/lineage"
    >
      <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3 flex-wrap">
        <GitMerge className="size-4 text-accent" />
        <span className="text-sm text-ink">
          This subnet is paired with its{" "}
          <span className="font-medium">{other.label.toLowerCase()}</span> counterpart
        </span>
        <ArrowRight className="size-3.5 text-ink-muted" />
        <Link
          to="/subnets/$netuid"
          params={{ netuid: other.netuid }}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-3 py-1 text-xs font-medium text-ink-strong hover:border-accent/50 hover:text-accent transition-colors"
        >
          <span className="font-mono tabular-nums text-ink-muted">
            {String(other.netuid).padStart(3, "0")}
          </span>
          {other.name ?? other.slug ?? `Subnet ${other.netuid}`}
        </Link>
        {link.matched_by ? (
          <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            matched · {link.matched_by}
          </span>
        ) : null}
      </div>
    </SectionAnchor>
  );
}
