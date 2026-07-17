/**
 * Whether any non-default filter/sort/page state is currently diverged from
 * the /endpoints table's defaults -- the enabled state of that page's
 * "Reset filters" button (#6386, extended #6579 to also cover sort/order/page,
 * which resetAll already restores but hasFilters didn't check).
 *
 * The subtlety is `callable` ("Callable only"), which defaults to `true`: like
 * subnets.index.tsx's `includeRoot` (#6270), it is toggling it OFF that makes it
 * an active filter, so the predicate checks `callable !== true`, not truthiness.
 * The prior inline check omitted `callable` entirely, so with the toggle as the
 * only active filter the Reset button stayed disabled -- even though resetAll
 * would have restored `callable: true` if it could have been clicked. #6579
 * found the same gap for `sort`/`order`/`page`: resetAll's navigate() omits
 * them (so they fall back to their schema defaults -- "netuid"/"asc"/1) but
 * the button's own title ("Clear search, filters, sort, and page") already
 * claimed to reset them.
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
  sort: string;
  order: string;
  page: number;
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
    search.callable !== true ||
    // resetAll's navigate() omits sort/order/page, so they fall back to these
    // schema defaults -- matching them here is what keeps the button's claimed
    // scope ("...sort, and page") and its enabled-state in sync (#6579).
    search.sort !== "netuid" ||
    search.order !== "asc" ||
    search.page !== 1
  );
}
