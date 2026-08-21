import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { ArrowUpRight } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { HomeNetworkSignalField } from "@/components/metagraphed/home-network-signal-field";
import { ContinueExploring } from "@/components/metagraphed/continue-exploring";
import { WhatChangedFeed } from "@/components/metagraphed/analytics/what-changed-feed";
import { TimeRangeProvider } from "@/components/metagraphed/analytics/time-range-context";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { Skeleton } from "@/components/metagraphed/states";
import {
  DataPageCanvas,
  DataPageDisclosure,
  DataPageHero,
  DataPageHeroTitleLine,
  DataPageModule,
  DataPageStage,
} from "@/components/metagraphed/primitives";
import { HubSections } from "@/components/metagraphed/hub-prose";
import { useRegistryEvents } from "@/hooks/use-registry-events";

/**
 * The public landing page is a data document, not a compressed explorer
 * dashboard. It gives a visitor one immediate visual truth, then routes them
 * to the dedicated tools that answer a specific follow-up question.
 */
export function OverviewPage() {
  // Keep the one live homepage visual current when a registry snapshot lands.
  // Secondary analysis is lazy below, so its data does not compete with first
  // paint or generate background work on an ordinary visit.
  useRegistryEvents();

  return (
    <AppShell chrome="landing" fullBleedMain flushTop>
      <HomeHero />

      <DataPageStage variant="landing">
        <DataPageCanvas variant="landing">
          <DataPageModule kind="navigation">
            <HomeNetworkSignalField />
          </DataPageModule>

          <DataPageModule kind="question" title="Choose a path">
            <HomeRouteRail />
          </DataPageModule>

          <DataPageModule kind="operations">
            <DataPageDisclosure label="Recent registry activity" lazy>
              <TimeRangeProvider>
                <QueryErrorBoundary fallback={() => null}>
                  <Suspense fallback={<Skeleton className="h-56 w-full" />}>
                    <WhatChangedFeed limit={3} />
                  </Suspense>
                </QueryErrorBoundary>
              </TimeRangeProvider>
            </DataPageDisclosure>

            <DataPageDisclosure label="Continue your research" lazy>
              <ContinueExploring />
            </DataPageDisclosure>

            <HubSections path="/" embedded />
          </DataPageModule>
        </DataPageCanvas>
      </DataPageStage>
    </AppShell>
  );
}

function HomeHero() {
  return (
    <DataPageHero
      id="home-title"
      variant="landing"
      ambient="document"
      eyebrow="Explorer / agent toolkit"
      title={
        <>
          <DataPageHeroTitleLine>Bittensor,</DataPageHeroTitleLine>
          <DataPageHeroTitleLine emphasis="focus">in focus.</DataPageHeroTitleLine>
        </>
      }
      description="Live chain context for people and agents."
      primaryActions={
        <>
          <Link to="/subnets" className="mg-focus-ring mg-page-primary-action">
            Explore subnets
            <ArrowUpRight className="size-3.5" />
          </Link>
        </>
      }
    />
  );
}

const HOME_DESTINATIONS = [
  { label: "Subnets", detail: "Live markets and public surfaces", to: "/subnets" },
  { label: "Validators", detail: "Stake, weights, and performance", to: "/validators" },
  { label: "Blocks", detail: "Recent chain activity", to: "/blocks" },
  { label: "Accounts", detail: "Identity, holdings, and events", to: "/accounts" },
  { label: "Updates", detail: "Registry changes and release notes", to: "/news/$" },
  { label: "Public APIs", detail: "Verified interfaces and schemas", to: "/apis" },
] as const;

/** Five direct explorer jobs, deliberately ruled rather than described as cards. */
function HomeRouteRail() {
  return (
    <nav className="mg-home-route-rail" aria-label="Explore Metagraphed">
      {HOME_DESTINATIONS.map((destination) => (
        <Link
          key={destination.to}
          to={destination.to}
          params={destination.to === "/news/$" ? { _splat: "" } : undefined}
          className="mg-home-route-link"
        >
          <span className="mg-home-route-name">{destination.label}</span>
          <span className="mg-home-route-detail">{destination.detail}</span>
          <ArrowUpRight className="mg-home-route-arrow" aria-hidden="true" />
        </Link>
      ))}
    </nav>
  );
}
