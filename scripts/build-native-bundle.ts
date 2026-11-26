/** Build the deployable native bundle: one reproducible archive holding exactly
 * what `native-entry.ts` needs to run, and nothing else.
 *
 * The fleet installs this the way it already installs `cloudflared` and
 * `dbmate` for this same lane — a public release asset pinned by URL and
 * sha256 in subnet-ops `hashistack/cluster.json` `client_artifacts`, verified
 * byte-for-byte by the machine root's pinned-artifact module and moved by
 * Renovate's GitHub-release manager. That is why this emits a **digest** rather
 * than publishing anywhere itself: the digest is the integrity boundary, and
 * the pin is a reviewed change in the consuming repository.
 *
 * Reproducible because the pin demands it. Two builds of one commit must agree
 * on the sha256 or the pin is unreviewable, so the archive is normalised: a
 * sorted entry list, a fixed mtime, zeroed owner/group, canonical modes, and
 * gzip without its timestamp field. `npm ci --omit=dev --ignore-scripts`
 * supplies the dependency tree from the committed lockfile with no install
 * script able to vary it.
 *
 * Node runs the TypeScript directly (engines.node >= 22.23.1), so there is no
 * bundler step and no transpiled output to drift from the source under test.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** Everything the process reads at runtime, and the manifests `npm ci` needs. */
const SOURCE_TREES = [
  "src",
  "workers",
  "generated",
  "dist/native",
  // The one workspace the runtime imports (@jsonbored/chain-summaries, two call
  // sites in src/workers). The other four are build- or UI-only and would add
  // the asset caches for nothing.
  "packages/chain-summaries",
] as const;
const MANIFESTS = ["package.json", "package-lock.json"] as const;
/** The generated OAuth provider `native-config.ts` loads by URL, emitted by
 * `build-native-oauth.ts`. This build runs that generator itself, so the check
 * below is a post-condition rather than an ordering rule a caller must know:
 * a bundle that cannot start fails here instead of at deploy. */
const REQUIRED_FILE = "dist/native/oauth-provider.mjs";
/** A fixed instant, so the archive's own metadata carries no build clock. */
const FIXED_MTIME = "2026-01-01T00:00:00Z";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(root, "dist");
const archiveName = "metagraphed-native.tar.gz";

/** The workspace directories the root manifest declares. */
function workspaces(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  return manifest.workspaces ?? [];
}

/** GNU tar, by name, or a refusal saying why no other tar will do.
 *
 * The normalisation flags below (`--mtime`, `--owner`, `--numeric-owner`,
 * `--format=gnu`) are GNU extensions. macOS ships bsdtar, which rejects them —
 * and a tar that silently ignored them would produce an archive whose digest
 * moved between builds, which is precisely what the sha256 pin cannot tolerate.
 * So this refuses rather than degrade: CI runs on Linux where `tar` is GNU, and
 * a developer on macOS needs `gtar` (Homebrew `gnu-tar`). */
function gnuTar(): string {
  for (const candidate of ["tar", "gtar"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /GNU tar/.test(probe.stdout)) return candidate;
  }
  throw new Error(
    "the reproducible bundle needs GNU tar: install it (macOS: brew install gnu-tar, " +
      "which provides gtar). bsdtar cannot apply the normalisation the sha256 pin depends on",
  );
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`,
    );
}

/** Every file under a tree, relative to `base` and sorted, so the entry order
 * is the archive's own and not the filesystem's. */
function filesUnder(directory: string, base: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(base, path));
    }
  };
  walk(directory);
  return found.sort();
}

function main(): void {
  for (const name of [...SOURCE_TREES.slice(0, 2), ...MANIFESTS]) {
    if (!existsSync(join(root, name)))
      throw new Error(`the bundle needs ${name}, which is not in the tree`);
  }
  // One command produces a complete bundle: the OAuth provider is generated
  // here rather than assumed, so the archive can never ship without it.
  run("node", ["scripts/build-native-oauth.ts"], root);
  if (!existsSync(join(root, REQUIRED_FILE)))
    throw new Error(
      `${REQUIRED_FILE} is missing after running its generator: the bundle would ` +
        "fail at startup, so it fails here instead",
    );

  const staging = mkdtempSync(join(tmpdir(), "metagraphed-native-"));
  try {
    for (const name of MANIFESTS) cpSync(join(root, name), join(staging, name));
    // Every workspace manifest, at its own path. The lockfile spans all five
    // workspaces, so `npm ci` reports a desynchronised tree ("Missing: ws@…
    // from lock file") when it cannot see them — even though only one of them
    // ships in the archive.
    for (const workspace of workspaces()) {
      const manifest = join(workspace, "package.json");
      if (!existsSync(join(root, manifest))) continue;
      mkdirSync(join(staging, workspace), { recursive: true });
      cpSync(join(root, manifest), join(staging, manifest));
    }

    // The dependency tree from the committed lockfile alone: no install script
    // may reach the archive, and no resolution happens at bundle time.
    // --install-links packs a workspace dependency as a real directory rather
    // than a symlink, so the archive holds no link pointing outside itself.
    run(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--install-links"],
      staging,
    );

    for (const tree of SOURCE_TREES) {
      const source = join(root, tree);
      if (existsSync(source))
        cpSync(source, join(staging, tree), { recursive: true });
    }

    // One walk of the staged tree is the entry list: the archive is built from
    // the bytes that will ship, never from the repository beside them, so a
    // file the copy missed cannot appear in the manifest as though it shipped.
    const staged = [
      ...MANIFESTS,
      ...[...SOURCE_TREES, "node_modules"]
        .map((tree) => join(staging, tree))
        .filter((tree) => existsSync(tree))
        .flatMap((tree) => filesUnder(tree, staging)),
    ].sort();

    const list = join(staging, ".bundle-entries");
    writeFileSync(list, staged.join("\n") + "\n");

    mkdirSync(outputDirectory, { recursive: true });
    const archive = join(outputDirectory, archiveName);
    rmSync(archive, { force: true });
    // GNU tar flags that remove every varying field, and `gzip -n` so the
    // compressor contributes no timestamp either. Together these make the
    // digest a function of content alone, which is what the pin requires.
    run(
      gnuTar(),
      [
        "--create",
        `--file=${archive}`,
        "--use-compress-program=gzip -n",
        "--format=gnu",
        `--mtime=${FIXED_MTIME}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=go-w",
        "--no-recursion",
        `--directory=${staging}`,
        `--files-from=${relative(staging, list)}`,
      ],
      staging,
    );

    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      archive: archiveName,
      sha256: digest,
      bytes: statSync(archive).size,
      entries: staged.length,
      node: process.version,
      // What the consuming pin must record beside the URL.
      pin: { sha256: digest },
    };
    writeFileSync(
      join(outputDirectory, "metagraphed-native.manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(JSON.stringify(manifest, null, 2));
    // The line the release workflow and the subnet-ops pin both read.
    console.log(`sha256=${digest}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
