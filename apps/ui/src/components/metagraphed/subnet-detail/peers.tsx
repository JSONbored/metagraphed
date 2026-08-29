import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  BrandIcon,
  LeaderCards,
  RankGrid,
  type RankGridItem,
} from "@jsonbored/ui-kit";
import { ErrorState } from "@/components/metagraphed/states";
import { domainsQuery } from "@/lib/metagraphed/queries";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import type { SubnetEconomics } from "@/lib/metagraphed/types";
import { formatPct } from "@/lib/metagraphed/format";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { domainPeers, emissionNeighbours } from "./subnet-detail-logic";

/**
 * Section 7 — the subnets this one is actually measured against.
 *
 * A subnet the registry has classified is compared with its domain; one it
 * has not is compared with its emission neighbours, which is the comparison
 * a reader would otherwise make by hand in the index. Never an empty
 * section: "no peers" is never the true answer.
 */
export function PeersSection({
  netuid,
  economics,
  economicsPending = false,
  economicsError = null,
  onRetryEconomics,
}: {
  netuid: number;
  economics: readonly SubnetEconomics[];
  economicsPending?: boolean;
  economicsError?: unknown;
  onRetryEconomics?: () => void;
}) {
  const { ref, nearViewport } = useNearViewport();
  const domains = useQuery({ ...domainsQuery(), enabled: nearViewport, retry: 0 });
  const economicsFailed = economicsError != null;
  // Economics is the comparison's essential input. Do not hide a known
  // failure behind an unrelated domain request that may still be in flight.
  const loading = nearViewport && !economicsFailed && (economicsPending || domains.isPending);
  const domain = (domains.data?.data ?? []).find((row) => row.netuids?.includes(netuid));
  const peers = domain
    ? domainPeers(economics, domain.netuids ?? [], 10)
    : emissionNeighbours(economics, netuid, 10);

  const items: RankGridItem[] = peers.map((peer) => ({
    key: String(peer.netuid),
    label: peer.name ?? `SN${peer.netuid}`,
    value: `${taoCompact(peer.total_stake_alpha)} α`,
    share:
      typeof peer.emission_share === "number" ? `${formatPct(peer.emission_share, 2)}` : undefined,
    href: `/subnets/${peer.netuid}`,
    current: peer.netuid === netuid,
  }));

  const compare = peers
    .filter((peer) => peer.netuid !== netuid)
    .slice(0, 4)
    .map((peer) => ({
      key: String(peer.netuid),
      name: peer.name ?? `SN${peer.netuid}`,
      sub: `SN${peer.netuid}`,
      value: typeof peer.emission_share === "number" ? `${formatPct(peer.emission_share, 2)}` : "—",
      href: `/compare?subnets=${netuid},${peer.netuid}`,
      // The subnet's own mark, not initials: "SN124" does not fit a 14px
      // avatar and rendered as clipped text in the corner of every card.
      avatar: <BrandIcon size={20} name={peer.name} netuid={peer.netuid} decorative />,
      initials: String(peer.netuid),
    }));

  return (
    <AnalyticsSection
      id="peers"
      name="Peers"
      question={
        !nearViewport
          ? "Comparable subnets by domain or neighboring emission rank."
          : loading
            ? "Finding the right peer group for comparison."
            : domain
              ? `Subnets in the ${domain.domain} domain by emission.`
              : domains.isError
                ? "Closest subnets by emission while domain context is unavailable."
                : "Subnets ranked either side of it by emission."
      }
      visualRef={ref}
      visual={
        !nearViewport || loading ? (
          <RankGrid
            items={[]}
            cols={5}
            ariaLabel="Loading subnet peer comparison"
            source={`sn-${netuid}-peer`}
            loading
            loadingItems={5}
          />
        ) : economicsFailed ? (
          <ErrorState
            error={economicsError}
            onRetry={onRetryEconomics}
            context="the subnet peer comparison"
          />
        ) : items.length > 0 ? (
          <RankGrid
            items={items}
            cols={5}
            ariaLabel={domain ? `${domain.domain} subnets by emission` : "Emission neighbours"}
            source={`sn-${netuid}-peer`}
          />
        ) : null
      }
      legend={
        !nearViewport || loading ? (
          <LeaderCards
            items={[]}
            featured={0}
            loading
            loadingItems={4}
            ariaLabel="Loading comparable subnets"
            source={`sn-${netuid}-compare`}
          />
        ) : compare.length > 0 ? (
          <LeaderCards
            items={compare}
            featured={0}
            ariaLabel="Compare with a peer"
            source={`sn-${netuid}-compare`}
          />
        ) : null
      }
      footnote={
        !nearViewport
          ? "registry domain when available · otherwise neighboring emission rank"
          : loading
            ? "loading subnet peer context"
            : economicsFailed
              ? "subnet economic context could not be loaded"
              : domain
                ? `${domain.subnet_count ?? peers.length} subnets · registry domain`
                : domains.isError
                  ? "registry domain unavailable · ranked by emission share"
                  : "no registry domain · ranked by emission share"
      }
    />
  );
}
