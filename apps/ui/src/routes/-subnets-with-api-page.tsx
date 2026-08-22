import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { AsyncPanel, Panel, TableSkeleton } from "@/components/metagraphed/primitives";
import {
  StatusBadge,
  type HealthStatus,
  SectionHead,
  EntityHero,
  FactSentence,
} from "@jsonbored/ui-kit";
import { HubSections, hubLede } from "@/components/metagraphed/hub-prose";
import { agentCatalogMapQuery } from "@/lib/metagraphed/queries";
import type { AgentCatalogSummary } from "@/lib/metagraphed/types";

/**
 * `/subnets/with-api` — the subnets publishing a machine-readable API contract.
 *
 * #11316 proposed three faceted pages. Two of them did not survive being
 * measured: `gpu_required` is set on **zero** of 129 subnets, and `status` is
 * uniformly "active" — one empty URL and one duplicate of /subnets. The third
 * did not survive either as written, because "has a probed surface" selects
 * **all 129**.
 *
 * What discriminates is whether a subnet publishes a SPECIFICATION: 66 of 126
 * carry an `openapi` service kind. That is also the honest reading of the query
 * this page targets — an address you can reach tells you nothing about what to
 * send it.
 */

/** The service kind that separates a documented API from a reachable one. */
const SPEC_KIND = "openapi";

/**
 * Readiness at or above this is treated as "integrate today" in the summary.
 * The distribution across the registry is 57 at >=90, 61 between 70 and 89 and
 * 11 below, so the bar selects a real minority rather than flattering everyone.
 */
const READY_SCORE = 90;

function specSubnets(map: Record<number, AgentCatalogSummary>): AgentCatalogSummary[] {
  return Object.values(map)
    .filter((entry) => (entry.service_kinds ?? []).includes(SPEC_KIND))
    .sort(
      (a, b) =>
        (b.integration_readiness ?? 0) - (a.integration_readiness ?? 0) || a.netuid - b.netuid,
    );
}

function WithApiTable() {
  const { data } = useSuspenseQuery(agentCatalogMapQuery());
  const rows = specSubnets(data.data);
  const total = Object.keys(data.data).length;
  const ready = rows.filter((r) => (r.integration_readiness ?? 0) >= READY_SCORE).length;
  const healthy = rows.filter((r) => r.health === "ok").length;

  return (
    <>
      {/*
        Synthesis first, list second — the rule #11313 §3 ships under. A bare
        filtered table is the page shape that put 5,797 URLs in "Crawled –
        currently not indexed"; the counts below are derived from probe data no
        competitor holds, and they are what makes this a page rather than a
        query string.
      */}
      <SectionHead
        name="What the registry currently shows"
        question={
          `${rows.length} of ${total} catalogued subnets publish a machine-readable API ` +
          `specification. ${ready} of those score ${READY_SCORE} or above on integration ` +
          `readiness, and ${healthy} answered their most recent probe. Every figure here is ` +
          `computed from this registry's own 15-minute probe cycle, not from operator claims.`
        }
      />
      <Panel>
        <table className="w-full text-left text-10">
          <caption className="sr-only">
            Bittensor subnets publishing a machine-readable API specification, ranked by integration
            readiness
          </caption>
          <thead>
            <tr className="border-b border-border text-ink-muted">
              <th scope="col" className="px-3 py-2">
                Subnet
              </th>
              <th scope="col" className="px-3 py-2">
                Readiness
              </th>
              <th scope="col" className="px-3 py-2">
                Services
              </th>
              <th scope="col" className="px-3 py-2">
                Last probe
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.netuid} className="border-b border-border/60">
                <th scope="row" className="px-3 py-2">
                  {/* A real anchor per row: this page's second job is linking
                      the subnet pages, and #11231 is what happens without it. */}
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: row.netuid }}
                    className="text-accent-text hover:underline"
                  >
                    SN{row.netuid} {row.name ?? ""}
                  </Link>
                </th>
                <td className="px-3 py-2 tabular-nums">{row.integration_readiness ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">
                  {row.callable_count ?? 0}/{row.service_count ?? 0}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={(row.health as HealthStatus) ?? "unknown"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

export function SubnetsWithApiPage() {
  return (
    <AppShell>
      <EntityHero
        name="Subnets with an API spec"
        sentence={<FactSentence>{hubLede("/subnets/with-api")}</FactSentence>}
      />
      <AsyncPanel context="subnets-with-api" fallback={<TableSkeleton rows={10} columns={4} />}>
        <WithApiTable />
      </AsyncPanel>
      <HubSections path="/subnets/with-api" />
    </AppShell>
  );
}
