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
 * The most UNREFERENCED routes allowed. THE CEILING ONLY FALLS.
 *
 * Unreferenced, not unrendered: this counts routes that appear nowhere in the
 * apps/ui source at all, which is a weaker claim than being rendered and is
 * the one the evidence supports. See the note beside the success line.
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
export const MAX_UNREFERENCED_ROUTES = 0;

/** Feed routes: consumed by feed readers, not by our UI. */
const FEED_PREFIX = "/api/v1/feeds/";

/** Network-prefixed testnet variants mirror their mainnet twin's rendering. */
const NETWORK_PREFIX = "/api/v1/{network}/";

/**
 * Routes whose consumer is an API CALLER rather than our own UI.
 *
 * The same exemption the feeds already have, named per route because this one
 * cannot be recognised by prefix. `/api/v1/networks` is a capability matrix --
 * which chains are addressable and which route families each one actually
 * serves -- and the thing that needs it is a client deciding what to call, not
 * a person reading a page. Rendering it in the UI to satisfy a checker would be
 * building a surface for the checker.
 *
 * EXPLICIT AND JUSTIFIED, one line each, because this is the mechanism most
 * likely to rot into "the list of routes we could not be bothered to render".
 * A route belongs here when its consumer is external BY DESIGN -- not when it
 * is merely unrendered today, which is what the ceiling is for.
 */
const EXTERNAL_CONSUMER_ROUTES: readonly string[] = [
  // Answers "what can this deployment serve", for a caller choosing a network
  // prefix. Its rendered form is the docs page that documents it.
  "/api/v1/networks",
];

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
        !route.startsWith(NETWORK_PREFIX) &&
        !route.startsWith(FEED_PREFIX) &&
        !EXTERNAL_CONSUMER_ROUTES.includes(route),
    )
    .sort();
}

/** Which of `routes` never appear in `source`. */
export function unreferencedRoutes(
  routes: readonly string[],
  source: string,
): string[] {
  return routes.filter((route) => !routePattern(route).test(source));
}

/**
 * One file's CODE, with comments removed.
 *
 * PROSE IS NOT A CONSUMER, and dropping `.mdx` alone does not achieve that: a
 * route path written in a `//` comment counts identically. Found by writing
 * one -- the component added for `/api/v1/accounts/{ss58}/identity-history`
 * explains itself by naming the route, and that sentence alone held the gate up
 * when the query beneath it was mutated away.
 *
 * STRING-AWARE ACROSS ALL THREE QUOTE FORMS, which is the whole difficulty. A
 * naive stripper eats `"https://…"` at the `//`, and this codebase builds route
 * paths in TEMPLATE literals -- `` `/api/v1/accounts/${ss58}/identity-history` ``
 * -- so backticks matter as much as quotes. Getting that wrong deletes the very
 * references the check exists to find, and it fails SILENTLY: the count climbs
 * and every entry looks like a real gap.
 */
export function stripCodeComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += ch;
      // A backslash escapes whatever follows, so a path ending `\"` does not
      // close the string.
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
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
  return files
    .map((file) => stripCodeComments(readFileSync(file, "utf8")))
    .join("\n");
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
  const unreferenced = unreferencedRoutes(routes, uiSource());

  if (unreferenced.length > MAX_UNREFERENCED_ROUTES) {
    console.error(
      `UI route references regressed: ${unreferenced.length} published route(s) appear ` +
        `nowhere in apps/ui, ceiling is ${MAX_UNREFERENCED_ROUTES}.\n` +
        `New routes must either be referenced or the gap grows silently, which is how ` +
        `#10300 went from 30 to 35 with nothing watching.\n` +
        unreferenced.map((route) => `  - ${route}`).join("\n"),
    );
    process.exit(1);
  }

  if (unreferenced.length < MAX_UNREFERENCED_ROUTES) {
    console.error(
      `UI route references improved: ${unreferenced.length} unreferenced, ceiling is ` +
        `${MAX_UNREFERENCED_ROUTES}. Lower MAX_UNREFERENCED_ROUTES in ` +
        `scripts/validate-ui-route-coverage.ts to ${unreferenced.length} so the ` +
        `gain is locked in -- a ceiling nobody lowers stops being a ratchet.`,
    );
    process.exit(1);
  }

  // "REFERENCED BY", not "rendered" (#10517). The failure messages above say
  // the same thing, which is where it matters most: that is the text somebody
  // reads while deciding what their PR has to do.
  //
  // This check matches a route path against the apps/ui source blob, so any
  // occurrence counts -- a comment, an `.mdx` line, or an ApiSourceFooter
  // `paths` entry, which is a plain string array and the case most likely to
  // occur by accident. It cannot see whether anything fetches the route or
  // whether the component holding it is ever mounted.
  //
  // THAT GAP IS NOT HYPOTHETICAL, measured 2026-08-15: excluding `.mdx` from
  // the blob turns up exactly one route, and it is genuinely unrendered --
  // `/api/v1/accounts/{ss58}/identity-history`, whose only occurrence anywhere
  // in apps/ui is a row in `content/docs/accounts.mdx`. No fetch, no
  // component. The check is green at a ceiling of 0 on documentation prose.
  //
  // NARROWING TO A FETCH LAYER DOES NOT WORK HERE, also measured: restricting
  // the blob to `lib/` and `hooks/` adds two false positives, and both are real
  // renders whose fetch lives in a component -- evidence-panel.tsx builds
  // `/api/v1/subnets/${netuid}/evidence` inline, and alert-trigger-lookup.tsx
  // exists specifically to render `/api/v1/alerts/triggers/{id}`.
  //
  // At a ceiling of 25 that slack did not matter: the check was a ratchet
  // against a backlog. At 0 it gets read as a guarantee, so the wording says
  // what was actually measured. #10517 tracks narrowing the evidence.
  console.log(
    MAX_UNREFERENCED_ROUTES === 0
      ? `UI route coverage: all ${routes.length} published route(s) are referenced by apps/ui ` +
          `(feeds excluded, their consumer is external).`
      : `UI route coverage: ${routes.length - unreferenced.length}/${routes.length} published route(s) referenced, ` +
          `${unreferenced.length} not (at the ceiling; feeds excluded, their consumer is external).`,
  );
}
