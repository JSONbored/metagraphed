import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./overflow-check.config.ts";
import { PROSE_ROUTES, SPECIMEN_ROUTES } from "./token-inventory.config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_TREE = path.join(HERE, "../../src/routeTree.gen.ts");
const ROUTES_DIR = path.join(HERE, "../../src/routes");

/**
 * Every path the router serves, from the generated tree rather than a list.
 *
 * `routeTree.gen.ts` is the only file that knows the full set — a hand list
 * goes stale the moment someone adds a file to `src/routes/`, and the sweep it
 * feeds then reports green on a route it has never loaded.
 */
function routerPaths(): string[] {
  const src = readFileSync(ROUTE_TREE, "utf8");
  // `FileRoutesByFullPath` and nothing else. The `path:` fields on each route
  // object are RELATIVE to the parent -- `/chain/analytics` appears there as
  // `'/analytics'` -- so reading them invents routes the router never serves,
  // and this gate then demands fixtures for them.
  const block = src.slice(
    src.indexOf("export interface FileRoutesByFullPath {"),
    src.indexOf("export interface FileRoutesByTo"),
  );
  if (!block) throw new Error("routeTree.gen.ts has no FileRoutesByFullPath block");
  const paths = new Set<string>();
  for (const m of block.matchAll(/^\s*'([^']+)':\s*typeof/gm)) paths.add(m[1]!);
  // The generated tree spells an index route both ways ("/accounts" and
  // "/accounts/"); they are one route, and counting both would make this gate
  // demand a fixture for a path that does not exist.
  const normalized = [...paths]
    .filter((p) => p.startsWith("/"))
    .map((p) => (p.length > 1 ? p.replace(/\/$/, "") : p));
  return [...new Set(normalized)].sort();
}

/**
 * Route path -> its file, read from each file's own `createFileRoute("...")`.
 *
 * Deriving the filename from the path does not work: `/chain/analytics` lives
 * in `chain.analytics.tsx`, `/subnets` in `subnets.index.tsx`, and a guess that
 * misses simply reports "not a redirect", which is the wrong answer in the
 * direction that makes this gate demand fixtures for pages that render nothing.
 */
function routeFiles(): Map<string, string> {
  const byPath = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.startsWith("-")) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/createFileRoute\(\s*"([^"]+)"/g)) {
          byPath.set(m[1]!.replace(/\/$/, "") || "/", full);
        }
      }
    }
  };
  walk(ROUTES_DIR);
  return byPath;
}

const ROUTE_FILES = routeFiles();

/** A route file that only throws a redirect renders nothing to sweep. */
function isRedirectOnly(routePath: string): boolean {
  const file = ROUTE_FILES.get(routePath);
  if (!file) return false;
  const src = readFileSync(file, "utf8");
  return /throw redirect\(/.test(src) && !/\bcomponent:/.test(src);
}

/**
 * Routes deliberately outside the design sweep, each with the reason.
 *
 * An exemption list is only honest when it is short and every entry says why —
 * a long one hides exactly what it names. These are the routes that either
 * render no page of our own or cannot be given a fixture.
 */
const NOT_SWEPT: Record<string, string> = {
  "/docs/$":
    "fumadocs owns this layout and type scale; allowedFamilies() already grants it Plex Sans",
  "/docs/raw/$": "a plain-text response, not a page",
  "/docs/llms.txt": "a plain-text response, not a page",
  "/news/$": "the same fumadocs layout as /docs/$",
  "/news/raw/$": "a plain-text response, not a page",
  "/news/llms.txt": "a plain-text response, not a page",
  "/api/search": "a JSON endpoint, not a page",
  "/graphql/explorer": "GraphiQL is a third-party editor with its own stylesheet",
};

describe("the design sweep covers every route the router serves", () => {
  it("reads a real route tree, so an empty result would be a parser failure", () => {
    expect(routerPaths().length).toBeGreaterThan(20);
  });

  it("sweeps, redirects, or names a reason for every route", () => {
    const swept = new Set(ROUTES.map((r) => r.split("?")[0]!));
    const unaccounted = routerPaths().filter((p) => {
      if (swept.has(p)) return false;
      if (p in NOT_SWEPT) return false;
      // Redirect first: a `$` route can be a redirect too (/subnets/category/
      // $slug is), and testing the prefix before the file would report it as
      // unswept even though it renders nothing.
      if (isRedirectOnly(p)) return false;
      // A parameterised route is swept through a concrete instance
      // (/subnets/$netuid via /subnets/1), so match on the prefix.
      if (p.includes("$")) {
        const prefix = p.slice(0, p.indexOf("$"));
        return ![...swept].some((s) => s.startsWith(prefix) && s.length > prefix.length);
      }
      return true;
    });
    expect(
      unaccounted,
      "these routes are neither swept by token-inventory/responsive-overflow, nor " +
        "redirect-only, nor listed in NOT_SWEPT with a reason. Add a fixture and " +
        "list them in overflow-check.config.ts, or say why they are exempt.",
    ).toEqual([]);
  });

  // The inverse of the rule above, which nothing asserted until #11693.
  // `/explorer` and `/portfolio` are `statusCode: 301` route files and both sat
  // in ROUTES: Playwright follows the hop, so the design sweep loaded /chain
  // and /settings twice each and replayed a HAR recorded against the page the
  // redirect had replaced. `har-coverage` could not catch it either -- a
  // redirect file declares no API paths, so its declared-but-unrecorded set is
  // empty and the check passes on a route it never measured.
  it("sweeps no route that only redirects", () => {
    const redirects = ROUTES.map((route) => route.split("?")[0]!).filter(isRedirectOnly);
    expect(
      redirects,
      "these swept routes throw a redirect instead of rendering, so the sweep " +
        "measures their TARGET -- twice, and through the wrong fixture. Sweep " +
        "the target instead.",
    ).toEqual([]);
  });

  it("lists no exemption for a route that no longer exists", () => {
    const known = new Set(routerPaths());
    expect(Object.keys(NOT_SWEPT).filter((p) => !known.has(p))).toEqual([]);
  });
});

describe("the design contract's own exemptions stay honest", () => {
  it("exempts a route from the structural rules only if it exists and is swept", () => {
    for (const route of Object.keys(SPECIMEN_ROUTES)) {
      expect(ROUTES, `${route} is exempted from the structural rules but not swept`).toContain(
        route,
      );
      expect(
        SPECIMEN_ROUTES[route]!.length,
        `${route}'s exemption gives no reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("grants the prose face only to routes that exist", () => {
    const known = new Set(routerPaths());
    const unknown = PROSE_ROUTES.filter((prefix) => ![...known].some((p) => p.startsWith(prefix)));
    expect(unknown, "these prose prefixes match no route the router serves").toEqual([]);
  });
});
