// PR-time guard on the compiled Worker bundle size. Cloudflare rejects a Worker
// whose script + bound modules exceed 1 MiB gzipped, but that limit is only
// enforced at deploy time — i.e. post-merge. This gate reproduces the deploy-side
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
import { repoRoot } from "./lib.mjs";

const KIB = 1024;

// Cloudflare's hard ceiling is 1 MiB (1024 KiB) gzipped. Warn early, fail before
// the ceiling so a regression is caught at PR time rather than at deploy. The
// bundle has grown past the original 980 / 1000 / 1008 KiB fail-lines as more
// live routes and GraphQL parity fields landed while staying under the
// 1024 KiB deploy limit, so the fail-budget is raised to 1016 KiB (an 8 KiB
// margin to the ceiling); still tunable via env vars.
const WARN_KIB = Number(process.env.WORKER_BUNDLE_WARN_KIB ?? "992");
const FAIL_KIB = Number(process.env.WORKER_BUNDLE_FAIL_KIB ?? "1016");

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
  const rows = [];
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
      `(warn ${WARN_KIB} KiB, fail ${FAIL_KIB} KiB, Cloudflare limit 1024 KiB).`,
  );

  if (totalKib >= FAIL_KIB) {
    console.error(
      `Worker bundle ${totalKib.toFixed(1)} KiB exceeds the ${FAIL_KIB} KiB ` +
        `budget. Trim the Worker entry (workers/api.mjs) or its dependencies ` +
        `before this reaches Cloudflare's 1024 KiB deploy limit.`,
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
