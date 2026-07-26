import {
  HubTabActions,
  HubTabs,
  activeHubTab,
  type HubTab,
} from "@/components/metagraphed/hub-tabs";

/**
 * The APIs hub's tab set (#8302, part of #8245).
 *
 * Surfaces vs Endpoints was a registry-internal distinction that leaked into
 * navigation: both pages advertised "3,101 tracked" and a visitor had no way to
 * tell which one answered their question. They are one concept — the public
 * interfaces this registry knows about, and whether they're up.
 *
 * Grows one PR at a time: Catalog and Live endpoints here, then Schemas and
 * Providers (#8303).
 */
export type ApisTab = HubTab;

export const APIS_TABS: readonly ApisTab[] = [
  {
    to: "/apis",
    label: "Catalog",
    blurb:
      "Every verified public interface across subnets — APIs, schemas, docs, dashboards and SDKs, filterable by kind, provider and netuid.",
  },
  {
    to: "/apis/endpoints",
    label: "Live endpoints",
    blurb:
      "Callable Subtensor and subnet endpoints — health, latency and pool eligibility, plus the managed RPC proxy.",
  },
] as const;

export function activeApisTab(pathname: string): ApisTab {
  return activeHubTab(APIS_TABS, pathname);
}

export function ApisTabs() {
  return <HubTabs tabs={APIS_TABS} ariaLabel="API sections" />;
}

export const ApisTabActions = HubTabActions;
