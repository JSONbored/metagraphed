import { defineConfig } from "@playwright/test";

// Dev server, matching the manual capture workflow in SKILL.md Phase C2 --
// same server, same defaults, so what this check verifies is what a
// contributor's own screenshot workflow would also render.
const PORT = 8080;
/**
 * The local API the built bundle talks to (#10938).
 *
 * MUST MATCH `build:worker:e2e`'s VITE_METAGRAPH_API_BASE: that value is baked
 * into the bundle at build time (`import.meta.env`), which is the only lever
 * that reaches the app's SSR fetches -- `page.routeFromHAR` intercepts the
 * browser and cannot see a request the server makes.
 */
const API_STUB_PORT = 8081;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // #10013: Playwright's default per-test budget is 30s, and these specs were
  // already spending most of it before any restart: sticky-table-header waits
  // up to 5s for networkidle and then up to 20s for the <thead> (measured --
  // /chain/extrinsics needs ~10s to paint its table), leaving under 5s of
  // slack on a route that was expected to be slow. That left no room for
  // gotoThroughRestart to wait out a supervised `wrangler dev` restart, so a
  // test landing in the restart window failed on the timeout instead.
  //
  // A cap is not a cost: a passing test finishes when it finishes, and this
  // only changes how long a genuinely stuck one is allowed to hang. 90s is the
  // 45s restart budget plus the ~25s these specs already use, rounded up.
  timeout: 90_000,
  reporter: process.env.CI ? "github" : "list",
  // #8928: pinned, because Playwright's default is os.cpus().length / 2 -- 2
  // workers on the 4-core ubuntu-latest runner, leaving half the machine idle
  // for what is the largest single block in the `ui` job. Pinned rather than
  // left implicit for a second reason: the default tracks the MACHINE, so the
  // same suite silently runs at a different width on a dev laptop than in CI,
  // which makes a local timing measurement non-transferable.
  //
  // 4 workers alone is NOT safe here, and that is measured, not assumed:
  // raising this number by itself (#8947) cut the step from ~249s to ~195s and
  // deterministically broke three tests -- the same three on both runs -- in
  // multisig-related-error.spec.ts and evidence-deep-link.spec.ts. None of
  // them is in the overflow sweep. They are navigation/hydration assertions
  // that lose their races when four Chromium instances saturate four cores.
  // The `projects` split below is what makes this number usable.
  //
  // A separate SERVER failure used to be blamed on this number too: the
  // `wrangler dev` process backing `webServer` exits partway through a run with
  // a bare `✘ [ERROR]` and an empty message, after which every navigation fails
  // ERR_EMPTY_RESPONSE -> ERR_CONNECTION_REFUSED. It reads as a different
  // "overflow" failure each run because the reported test is merely whichever
  // route was in flight.
  //
  // That cause is now KNOWN, from the wrangler log CI uploads on failure (the
  // "Upload e2e server + report artifacts on failure" step in validate.yml,
  // which had been capturing it all along):
  //
  //   Error in ProxyController: Error inside ProxyWorker
  //     cause: { message: 'Network connection lost.' }
  //
  // wrangler escalates a dropped ProxyWorker connection to a fatal error and
  // exits. It is upstream, it is not load-dependent, and worker count was never
  // the lever -- it reproduces on main at 2 workers. Browser automation drops
  // connections as a matter of course (a navigation supersedes in-flight
  // requests, a context closes with requests outstanding), so the trigger is
  // ordinary. tests/e2e/serve-e2e.ts supervises the process and restarts it, so
  // a crash costs the tests in flight rather than every test after it.
  //
  // CI stays at 2 for the reason that remains real: the three navigation and
  // hydration tests in the `interaction` project deterministically lose their
  // races when four Chromium instances saturate four cores.
  //
  // Local stays at 4: those races have never reproduced off-CI (repeated full
  // local runs passing, and 352 concurrent requests against the same built
  // worker without a single drop), so slowing the local loop would buy nothing.
  workers: process.env.CI ? 2 : 4,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  // Two phases, not one pool (#8928). The overflow sweep is 88 of the 94
  // tests, and every one of them is an independent page load + measurement --
  // it parallelizes cleanly and is where the wall time is. The remaining 6 are
  // interaction tests whose assertions wait on navigation and hydration, so
  // they are the ones that suffer under a saturated box.
  //
  // `dependencies` runs the sweep to completion FIRST, then the interaction
  // tests on an otherwise-idle machine. The ordering is deliberate in this
  // direction: a project whose dependency failed is SKIPPED, so putting the
  // sweep first means a broken interaction test costs the 6-test phase, while
  // the reverse would cost the 88-test phase and lose the overflow signal for
  // that run.
  projects: [
    {
      name: "overflow",
      testMatch: /responsive-overflow\.spec\.ts$/,
    },
    {
      // NOTE: a spec matching NEITHER project silently never runs. New specs
      // must be added to one of these patterns.
      //
      // sticky-table-header is a measurement sweep like the overflow one, not
      // an interaction test, and on pure test character it belongs in the
      // parallel phase above. It runs here instead, deliberately: the
      // `webServer` crash documented at the top of this file (bare
      // `✘ [ERROR]`, then ERR_CONNECTION_REFUSED for the rest of the run) is
      // load-related and unfixed from this side, and the overflow phase is
      // already 88 independent page loads against that one unsupervised
      // process. Adding 6 more to it traded a real increase in flake odds for
      // ~20s of wall time. Here they cost that 20s and add nothing to the
      // peak.
      name: "interaction",
      testMatch:
        /(about-state|account-detail-state|active-entity|agents-state|api-account-semantics|api-directory-state|block-detail|block-stream-prefetch|chain-overview-state|chain-stream-state|charts|command-palette-preload|compare-loading|content-runtime-isolation|contribute-state|deferred-stake-flow|directory-secondary-state|docs-mcp-layout|endpoint-search-state|error-state|event-detail|extrinsic-detail-state|footer-freshness-state|health-secondary-state|home-secondary-state|live-block-rail-prefetch|preferences-loading|provider-detail-state|providers-index-state|rank|revenue-state|schemas-state|settings-navigation|settings-state|subnet-secondary-state|validator-detail-state|validator-directory|crawlable-subnet-index|evidence-deep-link|indexable-routes|keyboard|multisig-related-error|offline|rendered-reader-copy|sticky-table-header|validator-unit-boundaries)\.spec\.ts$/,
      dependencies: ["overflow"],
      // Serial within the phase costs a few seconds and removes the last
      // source of self-contention for exactly the tests that proved sensitive
      // to it -- which now includes sticky-table-header: /chain/extrinsics
      // needs ~10s to paint its table and failed only under 4 workers.
      fullyParallel: false,
    },
    {
      // #11605: the design-system contract as a gate. Independent page loads
      // (one per route × theme), so it parallelizes like the overflow sweep;
      // it runs after `interaction` only so the three phases never contend.
      name: "token-inventory",
      testMatch: /token-inventory\.spec\.ts$/,
      dependencies: ["interaction"],
    },
  ],
  // TWO servers, stub FIRST. The app's `useSuspenseQuery` runs during SSR and
  // fetches before any HTML is streamed, so the stub has to be answering
  // before the app server takes its first request -- Playwright starts these
  // in order and waits for each `url` to respond.
  //
  // Before this, those SSR fetches went to live production on every run: the
  // sweep read a real API, and a production wobble failed a PR that touched
  // nothing (#10938 -- main went red three times on a backend-only commit).
  // Hermetic now, and measured: 92/92 in 34.2s against the stub, versus 3.3
  // minutes and a live dependency before.
  webServer: [
    {
      command: `node tests/e2e/api-stub.ts ${API_STUB_PORT}`,
      cwd: import.meta.dirname,
      // Its own health route, not `/`: the stub serves only /api/v1/**, so a
      // readiness probe on `/` would 404 forever.
      url: `http://127.0.0.1:${API_STUB_PORT}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // #8928: serve the PRODUCTION build, not `npm run dev`.
      //
      // The sweep is 26 routes x 4 viewports. Vite's dev server compiles each
      // route on first hit, so the old command paid that cost 26 times -- while
      // the same CI job already produced a production build and threw it away.
      // Measured against the built bundle: "/" 1.18s cold, "/subnets" 0.31s,
      // versus ~2.3s per test on the dev server.
      //
      // This deliberately changes WHAT is tested, from the dev bundle to the one
      // that actually ships -- so prod-only breakage the dev server hides is now
      // in scope. (.claude/skills/metagraphed/SKILL.md Phase C2 previously
      // pointed here for dev-server parity with the contributor screenshot flow;
      // that note is updated alongside this.)
      //
      // `wrangler dev` rather than `vite preview`: the cloudflare-module preset
      // emits a Worker (.output/server/index.mjs + its own generated
      // wrangler.json with the ASSETS binding), which vite preview cannot serve.
      // The build must therefore already exist -- in CI the `Build` step is
      // ordered before this one; locally, run `npm run build:worker` first.
      //
      // `dist/`, NOT `.output/`, and that distinction broke this once already:
      // a plain `npm run build` emits .output/ with no Worker entry, while the
      // cloudflare-module preset (LOVABLE_SANDBOX + NITRO_PRESET, which is what
      // CI and production use) emits dist/. Testing against the former locally
      // passed while CI had only the latter. `build:worker` exists so those two
      // env vars are never the thing you forgot.
      // Supervised, not bare `wrangler dev` -- see tests/e2e/serve-e2e.ts. The
      // dev server exits partway through a run and the port stops answering for
      // every test after it; the supervisor restarts it so that costs a retry
      // instead of the suite. The cause is now known and is upstream (the
      // wrangler log CI uploads on failure says ProxyController got
      // "Network connection lost" from the ProxyWorker), so the note above
      // about restoring 4 workers once that log identifies it is settled:
      // worker count was never the cause, and this is the mitigation.
      command: `node tests/e2e/serve-e2e.ts ${PORT}`,
      cwd: import.meta.dirname,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      // Booting a Worker + assets is slower to first byte than Vite's dev server,
      // and it is a one-time cost for the whole run rather than per route.
      timeout: 120_000,
    },
  ],
});
