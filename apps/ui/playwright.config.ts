import { defineConfig } from "@playwright/test";

// Dev server, matching the manual capture workflow in SKILL.md Phase C2 --
// same server, same defaults, so what this check verifies is what a
// contributor's own screenshot workflow would also render.
const PORT = 8080;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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
  workers: 4,
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
      name: "interaction",
      testMatch: /(evidence-deep-link|multisig-related-error|offline)\.spec\.ts$/,
      dependencies: ["overflow"],
      // 6 tests across 3 files. Serial within the phase costs a few seconds
      // and removes the last source of self-contention for exactly the tests
      // that proved sensitive to it.
      fullyParallel: false,
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
