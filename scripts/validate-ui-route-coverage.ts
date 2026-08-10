// Published routes the UI renders nowhere — a ceiling that only falls (#10300).
//
// #10300 measured 30 of 205 GET routes unreferenced by apps/ui. Re-measured
// while working the issue: 35 of 229. The gap did not stay still and nobody
// noticed, because nothing was watching — new routes ship, the UI does not
// grow to meet them, and the number drifts up one PR at a time.
//
// So this is a RATCHET, not a pass/fail on zero. Zero is not reachable today
// and pretending otherwise would mean an allowlist, which is worse: an
// exemption list stops being read the moment it is longer than a screen, and
// it hides exactly the thing it names. A ceiling that can only fall states the
// current number in one place, fails when it grows, and asks to be lowered
// whenever anyone renders one.
//
// ## What counts as "referenced"
//
// A route is referenced when its path appears in apps/ui source, with each
// `{token}` matching ONE path segment however it is constructed -- a literal,
// a `${expr}`, anything without a slash. That is the UI's actual idiom
// (`/api/v1/subnets/${netuid}/profile`), so a template literal counts.
//
// TWO THINGS THIS GETS WRONG IF DONE CASUALLY, both learned the hard way:
//
//   1. Literal segments must be REGEX-ESCAPED. A route containing a `.` --
//      every feed does, `/api/v1/feeds/gaps.atom` -- otherwise matches any
//      character there, and `gaps_atom` would clear it.
//   2. The generated docs tree mentions every route by construction. Left in,
//      the sweep reports 100% coverage and measures nothing at all.
//
// ## What is deliberately NOT counted as a gap
//
// The FEEDS. `/api/v1/feeds/*.atom|.rss|.json` are consumed by feed readers,
// not rendered by our own UI, so counting them measures the wrong thing --
// their consumer is external by design. Excluded by prefix rather than by
// name, so a new feed does not silently raise the ceiling.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib.ts";

/**
 * The most unrendered routes allowed. THE CEILING ONLY FALLS.
 *
 * NOW ZERO (#10300). Every published non-feed GET route is referenced by
 * apps/ui, so this has stopped being a ratchet with slack in it and become a
 * flat rule: a new route that nothing references fails CI. That is the gate
 * #10300 asked for -- "fails when a NEW route lands with no UI reference" --
 * and it is only enforceable because the backlog it was measuring is gone.
 *
 * WHAT IT PROVES IS A REFERENCE, NOT A RENDER (#10517). The evidence is a
 * string match over the apps/ui sources, which cannot tell a fetch from a
 * comment or see whether the component holding it is ever mounted. That was
 * fine for a ratchet against a backlog and is a weaker claim than a ceiling of
 * 0 invites; #10517 tracks narrowing it.
 *
 * Measured by RUNNING this check, never by subtracting feeds from a total by
 * hand, which is how the first value here came out one too low.
 *
 * If a route genuinely should not be rendered, this is the wrong place to say
 * so: raising the ceiling would hide every other gap behind one number. Add it
 * to a named exemption with a reason instead, so what is exempt stays legible
 * -- an undifferentiated allowance is exactly the shape that let this reach 35
 * with nothing watching.
 */
export const MAX_UNRENDERED_ROUTES = 0;

/** Feed routes: consumed by feed readers, not by our UI. */
const FEED_PREFIX = "/api/v1/feeds/";

/** Network-prefixed testnet variants mirror their mainnet twin's rendering. */
const NETWORK_PREFIX = "/api/v1/{network}/";

const escapeLiteral = (segment: string): string =>
  segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A path with `{token}` segments turned into a one-segment matcher. */
export function routePattern(route: string): RegExp {
  return new RegExp(
    route
      .split("/")
      .map((segment) =>
        /^\{.+\}$/.test(segment) ? "[^/`'\"\\s]+" : escapeLiteral(segment),
      )
      .join("/"),
  );
}

/** Every published mainnet GET route that is not a feed. */
export function publishedRoutes(openapi: {
  paths: Record<string, Record<string, unknown>>;
}): string[] {
  return Object.entries(openapi.paths ?? {})
    .filter(([, methods]) => Boolean(methods?.get))
    .map(([route]) => route)
    .filter(
      (route) =>
        !route.startsWith(NETWORK_PREFIX) && !route.startsWith(FEED_PREFIX),
    )
    .sort();
}

/** Which of `routes` never appear in `source`. */
export function unrenderedRoutes(
  routes: readonly string[],
  source: string,
): string[] {
  return routes.filter((route) => !routePattern(route).test(source));
}

function uiSource(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        // The generated reference tree names every route by construction.
        if (!full.includes("api-reference")) walk(full);
      } else if (/\.(ts|tsx|mdx|json)$/.test(name)) files.push(full);
    }
  };
  for (const root of ["apps/ui/src", "apps/ui/content"]) {
    try {
      walk(path.join(repoRoot, root));
    } catch {
      // A checkout without apps/ui is not this check's problem to report.
    }
  }
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

// The check runs only when this file is EXECUTED, never when it is imported.
// Its matchers are unit-tested, and a module that calls process.exit(1) at
// import time would take the whole test run down with it the moment the
// ceiling was actually breached -- turning one legible failure into a
// confusing one, in exactly the situation where legibility matters most.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

function main(): void {
  const openapi = JSON.parse(
    readFileSync(path.join(repoRoot, "public/metagraph/openapi.json"), "utf8"),
  ) as { paths: Record<string, Record<string, unknown>> };

  const routes = publishedRoutes(openapi);
  const unrendered = unrenderedRoutes(routes, uiSource());

  if (unrendered.length > MAX_UNRENDERED_ROUTES) {
    console.error(
      `UI route coverage regressed: ${unrendered.length} published route(s) are rendered nowhere, ` +
        `ceiling is ${MAX_UNRENDERED_ROUTES}.\n` +
        `New routes must either be rendered or the gap grows silently, which is how ` +
        `#10300 went from 30 to 35 with nothing watching.\n` +
        unrendered.map((route) => `  - ${route}`).join("\n"),
    );
    process.exit(1);
  }

  if (unrendered.length < MAX_UNRENDERED_ROUTES) {
    console.error(
      `UI route coverage improved: ${unrendered.length} unrendered, ceiling is ` +
        `${MAX_UNRENDERED_ROUTES}. Lower MAX_UNRENDERED_ROUTES in ` +
        `scripts/validate-ui-route-coverage.ts to ${unrendered.length} so the ` +
        `gain is locked in -- a ceiling nobody lowers stops being a ratchet.`,
    );
    process.exit(1);
  }

  // "REFERENCED BY", not "rendered" (#10517).
  //
  // This check matches a route path against the apps/ui source blob, so any
  // occurrence counts -- a comment, an `.mdx` line, or an ApiSourceFooter
  // `paths` entry, which is a plain string array and the case most likely to
  // occur by accident. It cannot see whether anything fetches the route or
  // whether the component holding it is ever mounted.
  //
  // At a ceiling of 25 that slack did not matter: the check was a ratchet
  // against a backlog. At 0 it gets read as a guarantee, so the wording says
  // what was actually measured. #10517 tracks narrowing the evidence.
  console.log(
    MAX_UNRENDERED_ROUTES === 0
      ? `UI route coverage: all ${routes.length} published route(s) are referenced by apps/ui ` +
          `(feeds excluded, their consumer is external).`
      : `UI route coverage: ${routes.length - unrendered.length}/${routes.length} published route(s) referenced, ` +
          `${unrendered.length} not (at the ceiling; feeds excluded, their consumer is external).`,
  );
}
