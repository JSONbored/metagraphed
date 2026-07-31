import { defineConfig } from "@playwright/test";

// Dev server, matching the manual capture workflow in SKILL.md Phase C2 --
// same server, same defaults, so what this check verifies is what a
// contributor's own screenshot workflow would also render.
const PORT = 8080;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // #8928: pinned, because Playwright's default is os.cpus().length / 2 --
  // 2 workers on the 4-core ubuntu-latest runner, leaving half the machine
  // idle for a check that is 26 routes x 4 viewports = 104 browser tests and
  // the single largest block in the `ui` job. Rendering is CPU-bound so the
  // gain is sublinear, not 2x. Pinned rather than left implicit for a second
  // reason: the default tracks the MACHINE, so the same suite silently runs
  // at a different width on a dev laptop than in CI, which makes a local
  // timing measurement non-transferable -- exactly why this issue was filed
  // rather than shipped on a local benchmark. Measured on CI; see the PR.
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
