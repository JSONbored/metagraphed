import { useQuery } from "@tanstack/react-query";
import { RankGrid, SectionHead } from "@jsonbored/ui-kit";
import { subnetMechanismsQuery } from "@/lib/metagraphed/queries";
import { formatPct } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { ErrorState } from "@/components/metagraphed/states";
import { mechanismShareRows, mechanismsNote } from "./subnet-detail-logic";

/**
 * How the subnet's emission divides between its mechanisms (MET-7365): each
 * mechanism's part of what the subnet is emitted, as the runtime splits it. A
 * grid only when there is something to divide -- most subnets run only the
 * mechanism every subnet has, and the note says so.
 *
 * Evidence under Value flow, not an eighth page question (#11604's page-shape
 * rule, held by tests/e2e/token-inventory.spec.ts), and addressable on its own
 * anchor. Nothing is fetched until the block nears the viewport.
 */
export function MechanismsEvidence({ netuid }: { netuid: number }) {
  const { ref, nearViewport } = useNearViewport<HTMLElement>();
  useRegisterApiSource(nearViewport ? [`/api/v1/subnets/${netuid}/mechanisms`] : []);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetMechanismsQuery(netuid),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();
  const loading = nearViewport && (!hydrated || isPending);
  const items = loading
    ? []
    : mechanismShareRows(data?.data).map((row) => ({
        key: row.key,
        label: row.label,
        share: formatPct(row.share, 1),
      }));

  return (
    <section
      id="mechanisms"
      className="mg-section-evidence"
      aria-labelledby="mechanisms-heading"
      ref={ref}
    >
      <SectionHead
        id="mechanisms-heading"
        name="Mechanisms"
        question="How this subnet's emission divides between its mechanisms."
      />
      {nearViewport && isError ? (
        <div className="mg-section-visual">
          <ErrorState error={error} onRetry={() => void refetch()} context="mechanisms" />
        </div>
      ) : items.length > 0 ? (
        <div className="mg-section-visual">
          <RankGrid
            items={items}
            cols={4}
            ariaLabel={`Subnet ${netuid} emission by mechanism`}
            source={`sn-${netuid}-mechanisms`}
          />
        </div>
      ) : null}
      <p className="mg-section-note">
        {!nearViewport
          ? "mechanisms · chain-direct"
          : loading
            ? "Loading mechanisms · chain-direct"
            : isError
              ? "chain-direct · retry the affected record above"
              : mechanismsNote(data?.data)}
      </p>
    </section>
  );
}
