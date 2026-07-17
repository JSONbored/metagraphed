/**
 * Automated before/after screenshot capture for a visual apps/ui PR (#3769).
 *
 * Drives a headless browser through the full Phase C2 capture matrix (3
 * viewports x 2 themes x before/after = 12 fixed-viewport PNGs, never
 * fullPage -- a full-page capture is exactly what broke #3757) against two
 * dev servers: one checked out at a base ref (default: the merge-base with
 * main), one at the current working tree. Generalizes the one-off
 * capture-*-screenshots.mjs scripts already in this directory (each hardcoded
 * to one PR's route/selectors) into a reusable, route-agnostic tool, and adds
 * the two-server orchestration none of them do.
 *
 * Usage:
 *   node tests/e2e/capture-pr-screenshots.mjs --route /status
 *   node tests/e2e/capture-pr-screenshots.mjs --route /subnets/1 \
 *     --section volume-24h --prefix 5483-volume
 *
 * Fast path for iterative work (servers you're already running -- e.g. an AI
 * coding tool mid-session, or a contributor who already has both dev servers
 * up): skip the worktree/install/spawn dance entirely and point at them.
 *   node tests/e2e/capture-pr-screenshots.mjs --route /status \
 *     --before-url http://localhost:8081 --after-url http://localhost:8080
 *
 * Writes 12 PNGs to --out (default tmp/pr-screenshots/), named
 * [<prefix>-]{before,after}-<viewport>-<theme>.png -- see SKILL.md Phase C2
 * step 6 for the table this feeds. Pass --push to also push them to the
 * `screenshots` branch on `origin` and print the ready-to-paste markdown
 * table with real raw.githubusercontent.com URLs filled in.
 *
 * Flags:
 *   --route <path>            required, e.g. /status or /subnets/1
 *   --base-ref <ref>          default: git merge-base main HEAD
 *   --section <id>            element id to scroll into view before
 *                              capturing (omit to capture at page top)
 *   --fallback-section <id>   section to scroll to on the "before" variant
 *                              when --section doesn't exist there yet (the
 *                              common case for a new section -- e.g. the
 *                              existing anchor it attaches after)
 *   --out <dir>               default: tmp/pr-screenshots
 *   --prefix <name>           filename prefix, e.g. an issue number
 *   --before-port / --after-port   default: 8081 / 8080
 *   --before-url / --after-url     skip orchestration, use running servers
 *   --keep-worktree           don't remove the before-ref worktree on exit
 *   --push                    push results to the `screenshots` branch and
 *                              print the PR markdown table
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, copyFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const THEME_STORAGE_KEY = "mg-theme";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];
const SERVER_READY_TIMEOUT_MS = 90_000;
const SERVER_POLL_INTERVAL_MS = 500;

function parseArgs(argv) {
  const parsed = {
    route: null,
    baseRef: null,
    section: null,
    fallbackSection: null,
    out: "tmp/pr-screenshots",
    prefix: "",
    beforePort: 8081,
    afterPort: 8080,
    beforeUrl: null,
    afterUrl: null,
    keepWorktree: false,
    push: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--route") parsed.route = argv[++i];
    else if (a === "--base-ref") parsed.baseRef = argv[++i];
    else if (a === "--section") parsed.section = argv[++i];
    else if (a === "--fallback-section") parsed.fallbackSection = argv[++i];
    else if (a === "--out") parsed.out = argv[++i];
    else if (a === "--prefix") parsed.prefix = argv[++i];
    else if (a === "--before-port") parsed.beforePort = Number(argv[++i]);
    else if (a === "--after-port") parsed.afterPort = Number(argv[++i]);
    else if (a === "--before-url") parsed.beforeUrl = argv[++i];
    else if (a === "--after-url") parsed.afterUrl = argv[++i];
    else if (a === "--keep-worktree") parsed.keepWorktree = true;
    else if (a === "--push") parsed.push = true;
    else if (a === "--help" || a === "-h") parsed.help = true;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node tests/e2e/capture-pr-screenshots.mjs --route <path> [options]

Required:
  --route <path>            Route to capture, e.g. /status or /subnets/1

Options:
  --base-ref <ref>          Base ref for "before" (default: merge-base with main)
  --section <id>            Element id to scroll into view (default: page top)
  --fallback-section <id>   Fallback scroll target for "before" when --section
                             doesn't exist there yet
  --out <dir>                Output directory (default: tmp/pr-screenshots)
  --prefix <name>            Filename prefix, e.g. an issue number
  --before-port <n>          Port for the before-ref server (default: 8081)
  --after-port <n>           Port for the after (current tree) server (default: 8080)
  --before-url <url>         Skip orchestration, use an already-running server
  --after-url <url>          Skip orchestration, use an already-running server
  --keep-worktree            Don't remove the before-ref worktree afterward
  --push                     Push results to the \`screenshots\` branch on
                              \`origin\` and print the PR markdown table
  --help                     Show this message
`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/** Prefers `origin/main` over local `main` -- a long-lived local checkout's
 * `main` branch is very often stale (never fast-forwarded), which would
 * silently point "before" at some arbitrary old commit instead of the real
 * base. Falls back to local `main` only if there's no `origin` remote. */
function resolveMainRef(cwd) {
  const result = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd });
  return result.status === 0 ? "origin/main" : "main";
}

function gitMergeBase(a, b, cwd) {
  return run("git", ["merge-base", a, b], { cwd });
}

/** True when the lockfile is unchanged between baseRef and HEAD -- when it
 * is, copying the current tree's already-installed node_modules into the
 * before-worktree is equivalent to a fresh install but skips a slow
 * (and, on a mismatched local Node/native-toolchain, occasionally broken --
 * see the `sharp` native-build gotcha) `npm install`. */
function lockfileUnchanged(baseRef) {
  const result = spawnSync("git", ["diff", "--quiet", baseRef, "HEAD", "--", "package-lock.json"], {
    cwd: repoRoot,
  });
  return result.status === 0;
}

async function waitForServer(url, label) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  throw new Error(
    `${label} server at ${url} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`,
  );
}

async function probeServerUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/** Spawns `npm run dev -- --port <port>` with `cwd` already inside
 * apps/ui (never `--workspace=apps/ui` here -- that flag resolves relative
 * to a monorepo root, and `cwd` already points at the workspace itself, so
 * combining them makes npm fail to find a nested "apps/ui" workspace and
 * exit immediately). stdout is suppressed (a chatty dev server would flood
 * the capture tool's own output) but stderr stays visible so a real startup
 * failure doesn't just silently time out in waitForServer. Caller is
 * responsible for waiting on readiness (waitForServer) and killing the
 * returned child on cleanup. */
function startDevServer(cwd, port) {
  const child = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}

function killServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
}

/** Creates a throwaway worktree at baseRef, wires up node_modules (copy if
 * the lockfile matches HEAD, fresh install otherwise -- see
 * lockfileUnchanged), and starts its dev server. Mirrors SKILL.md Phase C2
 * step 1's manual two-worktree flow. */
async function setupBeforeWorktree(baseRef, port) {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), "metagraphed-before-"));
  console.log(`Creating before-worktree at ${baseRef} -> ${worktreeDir}`);
  run("git", ["worktree", "add", "--detach", worktreeDir, baseRef], { cwd: repoRoot });

  if (lockfileUnchanged(baseRef)) {
    console.log("package-lock.json unchanged since base ref -- copying node_modules (fast path)");
    for (const rel of [
      "node_modules",
      "apps/ui/node_modules",
      "packages/client/node_modules",
      "packages/ui-kit/node_modules",
    ]) {
      const src = path.join(repoRoot, rel);
      const dest = path.join(worktreeDir, rel);
      if (await dirExists(src)) {
        run("cp", ["-R", src, dest]);
      }
    }
  } else {
    console.log(
      "package-lock.json changed since base ref -- running npm install (this may take a while)",
    );
    run("npm", ["install"], { cwd: worktreeDir, stdio: "inherit" });
  }

  const child = startDevServer(path.join(worktreeDir, "apps/ui"), port);
  return { worktreeDir, child };
}

async function dirExists(p) {
  try {
    const info = await stat(p);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function removeWorktree(worktreeDir) {
  console.log(`Removing before-worktree ${worktreeDir}`);
  const result = spawnSync("git", ["worktree", "remove", worktreeDir, "--force"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.warn(`Could not cleanly remove worktree (continuing): ${result.stderr}`);
  }
}

async function setTheme(page, baseUrl, theme) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: THEME_STORAGE_KEY,
    value: theme,
  });
}

/** `networkidle` is the right wait condition (it's what lets a late-mounting
 * chart or a client-side non-suspense query settle before capture -- see
 * capture-operational-status-screenshots.mjs), but a just-spawned dev
 * server's first hit on a route pays Vite's cold transform/optimize cost on
 * top of the app's own data fetches, occasionally blowing past a single
 * timeout. Retry once, then fall back to the cheaper `load` condition plus a
 * fixed settle wait rather than failing the whole capture run outright. */
async function gotoRoute(page, url) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    return;
  } catch (err) {
    console.warn(`networkidle wait failed for ${url}, retrying once: ${err.message}`);
  }
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    return;
  } catch (err) {
    console.warn(`networkidle retry failed for ${url}, falling back to "load": ${err.message}`);
  }
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(2000);
}

/** Scrolls `sectionId` into view, accounting for the sticky masthead's live
 * height, then re-scrolls once after a settle wait so late data-driven
 * layout shifts (queries resolving, charts mounting) don't push the target
 * back out of frame -- mirrors capture-operational-status-screenshots.mjs. */
async function scrollToSection(page, sectionId) {
  const scroll = () =>
    page.evaluate((id) => {
      const section = document.getElementById(id);
      if (!section) return false;
      const header = document.querySelector("header");
      const clearance = (header?.getBoundingClientRect().bottom ?? 0) + 12;
      const top = section.getBoundingClientRect().top + window.scrollY - clearance;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      return true;
    }, sectionId);

  const found = await scroll();
  if (!found) return false;
  await page.waitForTimeout(500);
  await scroll();
  await page.waitForTimeout(300);
  return true;
}

async function captureVariant({
  browser,
  baseUrl,
  variant,
  route,
  section,
  fallbackSection,
  outDir,
  prefix,
}) {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();

    for (const theme of THEMES) {
      await setTheme(page, baseUrl, theme);
      await gotoRoute(page, `${baseUrl}${route}`);
      // Let async, non-suspense queries (identity/balance/etc. -- anything
      // fetched client-side post-hydration) resolve before scrolling and
      // capturing, or the shot freezes on a loading skeleton.
      await page.waitForTimeout(1200);

      // Self-hosted brand fonts (apps/ui/src/styles.css) load via
      // font-display: swap, so the page paints in a fallback face first and
      // reflows onto the real one whenever its woff2 lands. That download is
      // real network activity, so the fixed wait above doesn't bound it -- a
      // cold `before` server can still be mid-swap while a warm `after` server
      // is already on the brand font. The pair then differs in *typeface*, and
      // every glyph shifts, which is exactly the noise a before/after
      // comparison must not have (responsive-overflow.spec.ts blocks on this
      // for the same reason -- see #4876). Block until the swap has happened.
      await page.evaluate(() => document.fonts.ready);

      if (section) {
        const found = await scrollToSection(page, section);
        if (!found && fallbackSection) {
          await scrollToSection(page, fallbackSection);
        }
      }
      await page.waitForTimeout(200);

      const name = [prefix, variant, viewport.name, theme].filter(Boolean).join("-");
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`wrote ${file}`);
    }
    await context.close();
  }
}

async function pushScreenshots(outDir, files) {
  const originUrl = run("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  const match = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Could not parse owner/repo from origin URL: ${originUrl}`);
  const [, owner, repo] = match;

  const pushWorktreeDir = await mkdtemp(path.join(os.tmpdir(), "metagraphed-screenshots-"));
  run("git", ["fetch", "origin"], { cwd: repoRoot });
  const remoteHasBranch =
    spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", "screenshots"], {
      cwd: repoRoot,
    }).status === 0;

  if (remoteHasBranch) {
    run("git", ["worktree", "add", pushWorktreeDir, "origin/screenshots", "-B", "screenshots"], {
      cwd: repoRoot,
    });
  } else {
    run("git", ["worktree", "add", "--detach", pushWorktreeDir, "origin/main"], { cwd: repoRoot });
    run("git", ["checkout", "--orphan", "screenshots"], { cwd: pushWorktreeDir });
    run("git", ["rm", "-rf", "--quiet", "."], { cwd: pushWorktreeDir });
  }

  for (const file of files) {
    await copyFile(path.join(outDir, file), path.join(pushWorktreeDir, file));
  }
  run("git", ["add", ...files], { cwd: pushWorktreeDir });
  run(
    "git",
    [
      "-c",
      "user.name=metagraphed-screenshot-tool",
      "-c",
      "user.email=noreply@metagraph.sh",
      "commit",
      "-m",
      `screenshots: ${files[0]?.replace(/-(before|after)-.*/, "") || "capture"}`,
    ],
    {
      cwd: pushWorktreeDir,
    },
  );

  // Rebase-and-retry once in case another push landed on the branch in the
  // meantime (a real, observed race when multiple contributors/AI sessions
  // use this branch concurrently).
  try {
    run("git", ["push", "origin", "screenshots"], { cwd: pushWorktreeDir });
  } catch {
    run("git", ["fetch", "origin", "screenshots"], { cwd: pushWorktreeDir });
    run("git", ["rebase", "origin/screenshots"], { cwd: pushWorktreeDir });
    run("git", ["push", "origin", "screenshots"], { cwd: pushWorktreeDir });
  }

  removeWorktree(pushWorktreeDir);

  console.log("\nPushed. Markdown table:\n");
  const byViewportTheme = new Map();
  for (const file of files) {
    const m = file.match(/-(before|after)-(mobile|tablet|desktop)-(light|dark)\.png$/);
    if (!m) continue;
    const [, variant, viewport, theme] = m;
    const key = `${viewport}-${theme}`;
    const entry = byViewportTheme.get(key) ?? {};
    entry[variant] = file;
    byViewportTheme.set(key, entry);
  }
  const order = [
    "desktop-light",
    "desktop-dark",
    "tablet-light",
    "tablet-dark",
    "mobile-light",
    "mobile-dark",
  ];
  console.log("| Viewport · Theme | Before | After |");
  console.log("| --- | --- | --- |");
  for (const key of order) {
    const entry = byViewportTheme.get(key);
    if (!entry?.before || !entry?.after) continue;
    const [viewport, theme] = key.split("-");
    const label = `${viewport[0].toUpperCase()}${viewport.slice(1)} · ${theme[0].toUpperCase()}${theme.slice(1)}`;
    const beforeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/screenshots/${entry.before}`;
    const afterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/screenshots/${entry.after}`;
    console.log(
      `| ${label} | [<img src="${beforeUrl}" width="260">](${beforeUrl})<br><sub>before</sub> | [<img src="${afterUrl}" width="260">](${afterUrl})<br><sub>after</sub> |`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.route) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const outDir = path.resolve(repoRoot, args.out);
  await mkdir(outDir, { recursive: true });

  const skipOrchestration = Boolean(args.beforeUrl && args.afterUrl);
  let beforeWorktree = null;
  let beforeServer = null;
  let afterServer = null;
  let beforeUrl = args.beforeUrl;
  let afterUrl = args.afterUrl;

  try {
    if (!skipOrchestration) {
      const baseRef = args.baseRef || gitMergeBase(resolveMainRef(repoRoot), "HEAD", repoRoot);
      console.log(`Base ref for "before": ${baseRef}`);

      afterUrl = args.afterUrl ?? `http://localhost:${args.afterPort}`;
      const afterAlreadyUp = await probeServerUp(afterUrl);
      if (afterAlreadyUp) {
        console.log(`Reusing already-running "after" server at ${afterUrl}`);
      } else {
        console.log(`Starting "after" server (current tree) on port ${args.afterPort}`);
        afterServer = startDevServer(path.join(repoRoot, "apps/ui"), args.afterPort);
      }

      const before = await setupBeforeWorktree(baseRef, args.beforePort);
      beforeWorktree = before.worktreeDir;
      beforeServer = before.child;
      beforeUrl = `http://localhost:${args.beforePort}`;

      console.log("Waiting for both dev servers to be ready...");
      await Promise.all([waitForServer(beforeUrl, "before"), waitForServer(afterUrl, "after")]);

      // A dev server responding on / doesn't mean the target route is warm --
      // Vite transforms each route's module graph lazily, on first hit. Pay
      // that cold-start cost here (best-effort, errors ignored) instead of on
      // the first real capture attempt below.
      console.log(`Warming up ${args.route} on both servers...`);
      await Promise.all([
        fetch(`${beforeUrl}${args.route}`).catch(() => {}),
        fetch(`${afterUrl}${args.route}`).catch(() => {}),
      ]);
    }

    console.log(`\nCapturing "before" (${beforeUrl})...`);
    const browser = await chromium.launch();
    await captureVariant({
      browser,
      baseUrl: beforeUrl,
      variant: "before",
      route: args.route,
      section: args.section,
      fallbackSection: args.fallbackSection,
      outDir,
      prefix: args.prefix,
    });

    console.log(`\nCapturing "after" (${afterUrl})...`);
    await captureVariant({
      browser,
      baseUrl: afterUrl,
      variant: "after",
      route: args.route,
      section: args.section,
      fallbackSection: null,
      outDir,
      prefix: args.prefix,
    });
    await browser.close();

    console.log(`\n12 screenshots written to ${outDir}`);

    if (args.push) {
      const files = (await readdir(outDir)).filter((f) => f.endsWith(".png"));
      await pushScreenshots(outDir, files);
    }
  } finally {
    killServer(beforeServer);
    killServer(afterServer);
    if (beforeWorktree && !args.keepWorktree) {
      removeWorktree(beforeWorktree);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
