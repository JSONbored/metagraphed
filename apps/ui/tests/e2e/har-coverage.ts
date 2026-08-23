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
import { HAR_DIR } from "./har-path.ts";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROUTES_DIR = path.join(HERE, "../../src/routes");

/** Trailing slash carries no routing meaning here but TanStack's index routes
 * declare one (`createFileRoute("/subnets/")`) while ROUTES lists `/subnets`. */
function normalize(pattern: string): string {
  // A swept entry may carry the query string that makes the page worth
  // sweeping (`/compare?subnets=1,19`); the route that serves it is the path.
  const path = pattern.split("?")[0]!;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Every `createFileRoute("...")` in the routes directory, pattern -> filename.
 *
 * A layout route and its index normalize to the SAME pattern -- `chain.tsx`
 * declares "/chain" and `chain.index.tsx` declares "/chain/" -- so one of them
 * has to win. The one that renders wins: since #11619 emptied the chain layout
 * of its component, resolving /chain to `chain.tsx` returned a file with no
 * imports and no declarations, and this gate reported /chain as declaring
 * nothing at all. Preferring the file that names a `component` picks the page
 * over the shell in every such pair, and leaves a lone layout resolvable when
 * there is no index beside it.
 */
export function routeFileIndex(routesDir: string = ROUTES_DIR): Map<string, string> {
  const index = new Map<string, string>();
  const renders = new Set<string>();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const src = readFileSync(path.join(routesDir, file), "utf8");
    const declared = src.match(/createFileRoute\(\s*"([^"]+)"\s*\)/);
    if (!declared) continue;
    const pattern = normalize(declared[1]);
    const rendering = /\bcomponent:\s*\S/.test(src);
    if (index.has(pattern) && renders.has(pattern) && !rendering) continue;
    index.set(pattern, file);
    if (rendering) renders.add(pattern);
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
 * The API paths a route DECLARES, however it declares them.
 *
 * Two conventions, both live: the legacy `<ApiSourceFooter paths={[...]}>` at
 * the bottom of a page, and the v2 `useRegisterApiSource(PATHS)` that the
 * rebuilt routes call instead -- usually with a module-level `const PATHS =
 * [...]`, and sometimes one file away, because the hero/shell that registers
 * them is shared and the route passes its own list in as a prop.
 *
 * Reading only the footer made this gate go blind exactly as each route was
 * rebuilt (#11620): a v2 page declares nothing a footer regex can see, so
 * `declaredApiPaths` returned [], every declared-but-unrecorded path became
 * the empty set, and the #10938 gate reported green on a page whose fixtures
 * had gone stale. A gate that can only pass is not a gate.
 *
 * So: collect `/api/...` string literals from a footer's `paths`, from an
 * inline `useRegisterApiSource([...])`, and from any module-level array a
 * `useRegisterApiSource(X)` or an `apiPaths={X}` names. Follows local
 * `./-name` imports because the convention splits them (`chain.index.tsx` is
 * the route, `-explorer-page.tsx` is the page); one hop is not always enough,
 * so this walks transitively with a visited set.
 */
export function declaredApiPaths(
  file: string,
  routesDirectory: string = ROUTES_DIR,
  seen: Set<string> = new Set(),
  /** Read only these exported components; empty means the whole file. */
  only: readonly string[] = [],
): string[] {
  const full = path.join(routesDirectory, file);
  if (seen.has(full) || !existsSync(full)) return [];
  seen.add(full);
  const whole = readFileSync(full, "utf8");
  // Narrow to one component's body ONLY when this module serves more than one
  // route -- that is the only case where reading it whole attributes one
  // page's dependencies to another. A module with a single page component
  // keeps being read whole, because its declarations routinely sit in a
  // sibling helper (`function ApiSources()` beside `ExplorerPage`) that no
  // slice of the component's own body would ever contain.
  const shared = routeComponents(routesDirectory).filter((name) =>
    whole.includes(`export function ${name}(`),
  );
  const src =
    only.length > 0 && shared.length > 1
      ? only.map((name) => componentBody(whole, name)).join("\n")
      : whole;
  const found: string[] = [];
  const literals = (text: string) => [...text.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
  // Which exported components this file renders, so a SHARED page module is
  // read only for the one its route names. #11620 folded three stream pages
  // into one file; reading all of it would tell the gate that /chain/blocks
  // depends on /api/v1/chain-events, and the only way to satisfy that is a
  // fixture entry no browser on that page could ever record.
  const rendered = [...whole.matchAll(/\bcomponent:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);

  for (const footer of src.matchAll(/<ApiSourceFooter[\s\S]{0,900}?paths=\{\[([\s\S]*?)\]\}/g)) {
    found.push(...literals(footer[1]));
  }
  // `useRegisterApiSource([...])` / `useRegisterApiSource([...NAME], ...)`.
  for (const call of src.matchAll(/useRegisterApiSource\(([\s\S]*?)\);/g)) {
    found.push(...literals(call[1]));
    // ...and the constants it names, wherever they are declared in this file.
    for (const ident of call[1].matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      found.push(...literals(constArray(whole, ident[1])));
    }
  }
  // A shell that registers on the page's behalf: `apiPaths={BLOCK_PATHS}`.
  for (const prop of src.matchAll(/(?:apiPaths|artifacts)=\{(?:\[)?([\s\S]{0,200}?)(?:\])?\}/g)) {
    found.push(...literals(prop[1]));
    for (const ident of prop[1].matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      found.push(...literals(constArray(whole, ident[1])));
    }
  }
  for (const imported of whole.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.\/[^"]+)"/g,
  )) {
    const specifiers = imported[1];
    const base = imported[2].replace(/^\.\//, "");
    // Only the rendered components this particular import brings in. An import
    // that carries none (a `type BlocksSearch` back-reference to the route,
    // say) contributes nothing and is read whole, which is how a page module
    // that imports a second page module still resolves.
    const names = rendered.filter((name) => new RegExp(`\\b${name}\\b`).test(specifiers));
    for (const ext of [".tsx", ".ts"]) {
      if (!existsSync(path.join(routesDirectory, base + ext))) continue;
      found.push(...declaredApiPaths(base + ext, routesDirectory, seen, names));
    }
  }
  return [...new Set(found)];
}

/**
 * Every name a `component:` in the routes directory points at, cached.
 *
 * Used to decide whether a page module is SHARED — a module that renders two
 * routes cannot be read whole for either of them without attributing the
 * other's dependencies too.
 */
const routeComponentCache = new Map<string, string[]>();
function routeComponents(routesDirectory: string): string[] {
  const hit = routeComponentCache.get(routesDirectory);
  if (hit) return hit;
  const names = new Set<string>();
  for (const file of readdirSync(routesDirectory)) {
    if (!file.endsWith(".tsx") || file.includes(".test.")) continue;
    const src = readFileSync(path.join(routesDirectory, file), "utf8");
    for (const m of src.matchAll(/\bcomponent:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  const list = [...names];
  routeComponentCache.set(routesDirectory, list);
  return list;
}

/**
 * One exported component's body, for a module that holds several.
 *
 * Sliced from `export function <name>(` to the next top-level `export`, so a
 * caller can read the declarations of the page it renders without inheriting
 * its siblings'. Returns the whole source when the name is absent, which is
 * the safe direction: over-reading a module makes the gate stricter, and a
 * silent under-read makes it blind.
 */
function componentBody(src: string, name: string): string {
  const at = src.indexOf(`export function ${name}(`);
  if (at === -1) return src;
  const next = src.indexOf("\nexport ", at + 1);
  return next === -1 ? src.slice(at) : src.slice(at, next);
}

/** The body of a module-level `const NAME = [ ... ]`, or "". */
function constArray(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = [`);
  if (at === -1) return "";
  const open = src.indexOf("[", at);
  const close = src.indexOf("]", open);
  return close === -1 ? "" : src.slice(open, close);
}

/** The distinct API pathnames a HAR fixture recorded, query strings dropped. */
export function harRecordedPaths(harPath: string): Set<string> {
  const har = JSON.parse(readFileSync(harPath, "utf8")) as {
    log: { entries: { request: { url: string } }[] };
  };
  const paths = new Set(
    har.log.entries.map((entry) => new URL(entry.request.url).pathname.replace(/\/+$/, "")),
  );
  // The HAR is half the fixture set. `page.routeFromHAR` intercepts what the
  // BROWSER asks for; a route whose queries run under `useSuspenseQuery` is
  // fetched by the WORKER before any HTML streams, and those responses live in
  // har/ssr-supplement.json, which api-stub.ts replays for exactly that half.
  // Counting only the HAR reported a page as depending on live production when
  // the local stub had its bytes on disk all along -- which is why the
  // known-uncovered list carried entries no amount of re-recording could ever
  // clear (`/api/v1/blocks/summary`, `/api/v1/extrinsics`, `/api/v1/chain/…`).
  for (const url of supplementPaths()) paths.add(url);
  return paths;
}

let supplementCache: string[] | null = null;
/** The pathnames har/ssr-supplement.json can replay, query strings dropped. */
function supplementPaths(): string[] {
  if (supplementCache) return supplementCache;
  const file = path.join(HAR_DIR, "ssr-supplement.json");
  if (!existsSync(file)) return (supplementCache = []);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return (supplementCache = Object.keys(raw).map((url) => url.split("?")[0]!.replace(/\/+$/, "")));
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
