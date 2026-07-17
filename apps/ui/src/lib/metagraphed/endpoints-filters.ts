/**
 * Whether any non-default filter is currently narrowing the /endpoints table --
 * the enabled state of that page's "Reset filters" button (#6386).
 *
 * The subtlety is `callable` ("Callable only"), which defaults to `true`: like
 * subnets.index.tsx's `includeRoot` (#6270), it is toggling it OFF that makes it
 * an active filter, so the predicate checks `callable !== true`, not truthiness.
 * The prior inline check omitted `callable` entirely, so with the toggle as the
 * only active filter the Reset button stayed disabled -- even though resetAll
 * would have restored `callable: true` if it could have been clicked.
 *
 * Kept pure (a plain predicate over the URL search state) so it is unit-tested
 * apart from the route/DOM, mirroring filter-disclosure.ts.
 */
export interface EndpointsFilterState {
  q: string;
  category: string;
  provider: string;
  health: string;
  netuid: string;
  region: string;
  eligibility: string;
  callable: boolean;
}

export function endpointsFiltersActive(search: EndpointsFilterState): boolean {
  return (
    search.q !== "" ||
    search.category !== "all" ||
    search.provider !== "" ||
    search.health !== "" ||
    search.netuid !== "" ||
    search.region !== "" ||
    search.eligibility !== "" ||
    // Defaults to true; hiding directory links is what makes it "active" (#6386).
    search.callable !== true
  );
}
