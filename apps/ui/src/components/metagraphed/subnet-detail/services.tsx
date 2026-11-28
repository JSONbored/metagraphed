import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  SectionHead,
  safeExternalUrl,
  type DataTableColumn,
  type SectionNavLink,
} from "@jsonbored/ui-kit";
import { subnetServicesQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { ErrorState } from "@/components/metagraphed/states";
import type { SubnetService } from "@/lib/metagraphed/types";
import { servicesNote } from "./subnet-detail-logic";

/**
 * A service URL is whatever the key's owner published. It is a link only when
 * it is a public http(s) address (`safeExternalUrl`; anything else reads as
 * text), and it is never followed for ranking or handed this page as referrer.
 */
const PublishedLink: SectionNavLink = ({ href, children, ...rest }) => (
  <a href={href} {...rest} rel="nofollow ugc noopener noreferrer">
    {children}
  </a>
);

const COLUMNS: DataTableColumn<SubnetService>[] = [
  { key: "hotkey", label: "Hotkey", kind: "identifier", value: (row) => row.hotkey },
  {
    key: "service_url",
    label: "Service URL",
    kind: "link",
    wrap: true,
    value: (row) => row.service_url,
    href: (row) => safeExternalUrl(row.service_url),
  },
  {
    key: "set_at",
    label: "Set",
    kind: "number",
    value: (row) => row.set_at,
    format: (value) => (typeof value === "number" ? `#${formatNumber(value)}` : "—"),
    demote: true,
  },
];

/**
 * The service URLs this subnet's hotkeys bind on chain (MET-7365,
 * `SubtensorModule.Services`): what the subnet publishes about itself beside
 * the surfaces the registry probes. A table only when something is bound; the
 * note keeps "nothing bound at the last whole read" apart from "not read".
 *
 * Evidence under Surfaces, not an eighth page question (#11604's page-shape
 * rule), and addressable on its own anchor. Nothing is fetched until the
 * block nears the viewport.
 */
export function ServicesEvidence({ netuid }: { netuid: number }) {
  const { ref, nearViewport } = useNearViewport<HTMLElement>();
  useRegisterApiSource(nearViewport ? [`/api/v1/subnets/${netuid}/services`] : []);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetServicesQuery(netuid),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();
  const loading = nearViewport && (!hydrated || isPending);
  const rows = loading ? [] : (data?.data.services ?? []);

  return (
    <section
      id="services"
      className="mg-section-evidence"
      aria-labelledby="services-heading"
      ref={ref}
    >
      <SectionHead
        id="services-heading"
        name="On-chain services"
        question="The service URLs this subnet's hotkeys publish on chain."
      />
      {nearViewport && isError ? (
        <div className="mg-section-visual">
          <ErrorState error={error} onRetry={() => void refetch()} context="on-chain services" />
        </div>
      ) : rows.length > 0 ? (
        <div className="mg-section-visual">
          <DataTable
            rows={rows}
            columns={COLUMNS}
            rowKey={(row) => row.hotkey}
            caption={`Subnet ${netuid} on-chain services`}
            source={`sn-${netuid}-services`}
            link={PublishedLink}
            storageKey="subnet-services-columns"
            mobile="cards"
          />
        </div>
      ) : null}
      <p className="mg-section-note">
        {!nearViewport
          ? "on-chain services · chain-direct"
          : loading
            ? "Loading on-chain services · chain-direct"
            : isError
              ? "chain-direct · retry the affected record above"
              : servicesNote(data?.data)}
      </p>
    </section>
  );
}
