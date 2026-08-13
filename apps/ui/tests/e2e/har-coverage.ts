// Does a route's HAR fixture cover the API paths that route's page DECLARES?
//
// WHY THIS IS NOT ACADEMIC (#10938). responsive-overflow.spec.ts replays a HAR
// so the sweep is deterministic, but `page.routeFromHAR` intercepts the
// BROWSER only. The app also fetches during SSR -- router.tsx wires
// `setupRouterSsrQueryIntegration`, so a route's `useSuspenseQuery` runs in the
// worker -- and those requests reach live production on every run. With
// `notFound: "fallback"` they do it silently.
//
// So a declared path absent from the fixture is a live-production dependency
// wearing a fixture's clothes. What that cost: `main` failed the `ui` job three
// consecutive times on e1bd435ab, a BACKEND-only commit that touched
// `src/table-freshness-watchdog.ts` and nothing under apps/ui. A commit that
// cannot touch the page cannot break the page -- the gate was reading
// production, and production wobbled.
//
// The check is STATIC on purpose. Reading the declared paths out of the
// rendered DOM would be truer to runtime, but it needs the page to load, which
// needs SSR, which needs production -- a coverage check that goes down with the
// outage it exists to catch. Parsing the source needs nothing but the repo, so
// it still answers while production is unreachable.
//
// The pairing it checks is the page's own `<ApiSourceFooter paths={[...]}>`:
// the list the page publishes to users as "data sources", which is the closest
// thing to a declaration of what the route reads. It is a LOWER bound -- a
// query whose path never reaches the footer is invisible here -- so this
// answers "is the fixture missing something the page admits to", not "is the
// fixture complete".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROUTES_DIR = path.join(HERE, "../../src/routes");

/** Trailing slash carries no routing meaning here but TanStack's index routes
 * declare one (`createFileRoute("/subnets/")`) while ROUTES lists `/subnets`. */
function normalize(pattern: string): string {
  return pattern.length > 1 ? pattern.replace(/\/+$/, "") : pattern;
}

/** Every `createFileRoute("...")` in the routes directory, pattern -> filename. */
export function routeFileIndex(routesDir: string = ROUTES_DIR): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const src = readFileSync(path.join(routesDir, file), "utf8");
    const declared = src.match(/createFileRoute\(\s*"([^"]+)"\s*\)/);
    if (declared) index.set(normalize(declared[1]), file);
  }
  return index;
}

/**
 * The file serving one concrete URL, or a throw.
 *
 * THROWS RATHER THAN RETURNING NULL. A resolver that answers "nothing here"
 * for a route it merely failed to parse would report full coverage for the
 * routes it cannot see -- the failure mode where a gate is loudest about the
 * cases it already handles and silent about the ones it does not.
 */
export function resolveRouteFile(route: string, index: Map<string, string>): string {
  const exact = index.get(normalize(route));
  if (exact) return exact;
  // `/accounts/$ss58` serves `/accounts/5Gsb...`; prefer the most specific
  // pattern so a param route cannot shadow a literal one.
  const matches = [...index.entries()]
    .filter(([pattern]) => {
      if (!pattern.includes("$")) return false;
      const rx = new RegExp(`^${pattern.replace(/\$[A-Za-z0-9_]+/g, "[^/]+")}$`);
      return rx.test(normalize(route));
    })
    .sort((a, b) => b[0].length - a[0].length);
  if (matches.length > 0) return matches[0][1];
  throw new Error(
    `No createFileRoute() in apps/ui/src/routes declares ${route}. Either the ` +
      `route moved, or ROUTES in overflow-check.config.ts names a URL this app ` +
      `no longer serves -- both make the sweep measure a page nobody visits.`,
  );
}

/**
 * The `<ApiSourceFooter paths={[...]}>` entries reachable from one route file.
 *
 * Follows local `./-name` imports because the convention splits them:
 * `chain.analytics.tsx` is the route and `-chain-analytics-page.tsx` renders
 * the footer. One hop is not enough (`-chain-hub.tsx` sits between some), so
 * this walks transitively with a visited set.
 */
export function declaredApiPaths(
  file: string,
  routesDirectory: string = ROUTES_DIR,
  seen: Set<string> = new Set(),
): string[] {
  const full = path.join(routesDirectory, file);
  if (seen.has(full) || !existsSync(full)) return [];
  seen.add(full);
  const src = readFileSync(full, "utf8");
  const found: string[] = [];
  for (const footer of src.matchAll(/<ApiSourceFooter[\s\S]{0,900}?paths=\{\[([\s\S]*?)\]\}/g)) {
    found.push(...[...footer[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  }
  for (const imported of src.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
    const base = imported[1].replace(/^\.\//, "");
    for (const ext of [".tsx", ".ts"]) {
      if (existsSync(path.join(routesDirectory, base + ext))) {
        found.push(...declaredApiPaths(base + ext, routesDirectory, seen));
      }
    }
  }
  return [...new Set(found)];
}

/** The distinct API pathnames a HAR fixture recorded, query strings dropped. */
export function harRecordedPaths(harPath: string): Set<string> {
  const har = JSON.parse(readFileSync(harPath, "utf8")) as {
    log: { entries: { request: { url: string } }[] };
  };
  return new Set(
    har.log.entries.map((entry) => new URL(entry.request.url).pathname.replace(/\/+$/, "")),
  );
}

export interface RouteCoverage {
  declared: string[];
  recorded: string[];
  /** Declared paths with no recorded entry -- each one an SSR fetch that
   * reaches live production on every sweep. */
  missing: string[];
}

/**
 * Is `declared` recorded, allowing `{param}` to stand for one path segment?
 *
 * A footer may publish a TEMPLATE (`/api/v1/accounts/{ss58}`) where the HAR can
 * only ever hold a concrete URL. Comparing those literally would demand a
 * recording that cannot exist, and the honest response to an impossible
 * requirement is to weaken the requirement, not to suppress the finding.
 */
export function isRecorded(declared: string, recorded: Set<string>): boolean {
  const path = declared.replace(/\/+$/, "");
  if (recorded.has(path)) return true;
  if (!path.includes("{")) return false;
  const rx = new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^/]+")}$`,
  );
  return [...recorded].some((r) => rx.test(r));
}

export function coverageForRoute(
  route: string,
  harPath: string,
  index: Map<string, string> = routeFileIndex(),
  routesDirectory: string = ROUTES_DIR,
): RouteCoverage {
  const declared = declaredApiPaths(resolveRouteFile(route, index), routesDirectory);
  const recorded = harRecordedPaths(harPath);
  return {
    declared,
    recorded: [...recorded].sort(),
    missing: declared.filter((p) => !isRecorded(p, recorded)).sort(),
  };
}
