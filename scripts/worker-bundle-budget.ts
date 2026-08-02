// PR-time guard on the compiled Worker bundle size. Cloudflare rejects a Worker
// whose script + bound modules exceed the plan's gzipped size limit, and that
// limit is only enforced at deploy time — i.e. post-merge. This gate reproduces the deploy-side
// bundling locally via `wrangler deploy --dry-run` (no network/auth required),
// gzip-measures the produced Worker JS + wasm modules (NOT the ./public assets,
// which don't count against the Worker script limit), and fails the build if the
// total crosses the budget. Mirrors the metagraphed-ui ci.yml bundle-budget gate
// in spirit: a soft warn well below the hard ceiling, a hard fail comfortably
// under Cloudflare's 1 MiB limit. Both thresholds are tunable via env vars.
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./lib.ts";

const KIB = 1024;

// Cloudflare's gzipped script limit is 3 MB on Workers Free and 10 MB on
// Workers Paid (developers.cloudflare.com/workers/platform/limits/). This
// account is Paid -- Hyperdrive, Smart Placement and Workers Builds are all
// paid-only and all are in use -- so the real ceiling is 10 MB.
//
// It was NOT always read that way. Until #9059 this gate asserted a 1 MiB
// (1024 KiB) ceiling and sat at a 1020 KiB fail line, "a 4 KiB margin". That
// number was ~10x too small, and it was load-bearing: src/usage-telemetry.ts
// cited it to justify hand-writing a PostHog client (a V8 stack-trace regex
// parser and a hand-maintained $exception wire shape) rather than importing
// the ~40 KiB official SDK. Measured at the time of that correction the entry
// was 531 KiB -- about 5% of the true budget, not "within a few KiB of the
// limit". Keep the real number here: a wrong budget does not just fail late,
// it silently shapes the architecture around it.
//
// The gate stays, because a bundle budget is still worth having -- an
// unnoticed multi-MB dependency is a real cold-start and deploy risk. It just
// guards the ceiling that exists, with headroom expressed as a fraction of it
// rather than a hairline. Both thresholds stay tunable via env vars.
const CLOUDFLARE_PAID_LIMIT_KIB = 10 * 1024;
// ~20% of the ceiling warns, ~40% fails: generous room for ordinary growth,
// while still catching a dependency that doubles the bundle in one PR.
const WARN_KIB = Number(process.env.WORKER_BUNDLE_WARN_KIB ?? "2048");
const FAIL_KIB = Number(process.env.WORKER_BUNDLE_FAIL_KIB ?? "4096");

if (!Number.isFinite(WARN_KIB) || !Number.isFinite(FAIL_KIB)) {
  console.error("Invalid WORKER_BUNDLE_WARN_KIB/WORKER_BUNDLE_FAIL_KIB value.");
  process.exit(1);
}

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-bundle-"));

try {
  const result = spawnSync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "--outdir", outDir],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.status !== 0) {
    console.error("wrangler deploy --dry-run failed:");
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    process.exit(1);
  }

  // The deployable Worker bundle is the produced JS entry plus any bound wasm
  // modules. Source maps (.map) and asset metadata (README.md) are not uploaded
  // to the Worker, so they're excluded from the measurement.
  const entries = await fs.readdir(outDir);
  const moduleFiles = entries
    .filter((name) => name.endsWith(".js") || name.endsWith(".wasm"))
    .sort();

  if (moduleFiles.length === 0) {
    console.error(`No Worker modules found in dry-run output (${outDir}).`);
    process.exit(1);
  }

  let totalGzip = 0;
  const rows: { name: string; gzip: number }[] = [];
  for (const name of moduleFiles) {
    const bytes = await fs.readFile(path.join(outDir, name));
    const gzip = gzipSync(bytes, { level: 9 }).length;
    totalGzip += gzip;
    rows.push({ name, gzip });
  }

  const totalKib = totalGzip / KIB;
  for (const row of rows) {
    console.log(`  ${row.name}: ${(row.gzip / KIB).toFixed(1)} KiB gzipped`);
  }
  console.log(
    `Worker bundle: ${totalKib.toFixed(1)} KiB gzipped ` +
      `(warn ${WARN_KIB} KiB, fail ${FAIL_KIB} KiB, ` +
      `Cloudflare Paid limit ${CLOUDFLARE_PAID_LIMIT_KIB} KiB — ` +
      `${((totalKib / CLOUDFLARE_PAID_LIMIT_KIB) * 100).toFixed(1)}% used).`,
  );

  if (totalKib >= FAIL_KIB) {
    console.error(
      `Worker bundle ${totalKib.toFixed(1)} KiB exceeds the ${FAIL_KIB} KiB ` +
        `budget. Trim the Worker entry (workers/api.ts) or its dependencies ` +
        `before this reaches Cloudflare's ${CLOUDFLARE_PAID_LIMIT_KIB} KiB ` +
        `Paid-plan deploy limit.`,
    );
    process.exit(1);
  }

  if (totalKib >= WARN_KIB) {
    console.warn(
      `::warning::Worker bundle ${totalKib.toFixed(1)} KiB is within ` +
        `${(FAIL_KIB - totalKib).toFixed(1)} KiB of the ${FAIL_KIB} KiB fail ` +
        `budget. Keep an eye on the Worker bundle size.`,
    );
  }

  console.log("Worker bundle budget check passed.");
} finally {
  await fs.rm(outDir, { recursive: true, force: true });
}
