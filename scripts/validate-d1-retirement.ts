import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, stripJsonComments } from "./lib.ts";

/**
 * Refuse D1 retirement while any deployed Worker config still lets a store
 * fall through to D1 (metagraphed-infra#884 gate 9). The fallthrough is
 * config-borne: `selectedD1Store` (src/d1-store.ts) selects only when
 * `vars.D1_STATE_TABLES` names tables and the `D1_STATE` binding is wired,
 * and `D1_EXPORT_REVISIONS` keeps the export lane alive — so retirement is
 * possible exactly when no deployed config carries a `d1_databases` binding,
 * a non-empty `D1_STATE_TABLES`, or an enabled `D1_EXPORT_REVISIONS`. Until
 * then this program exits 1 naming each survivor, so the retirement step
 * cannot run past a live consumer. An unreadable config counts as a live
 * consumer: a parse failure must never read as "nothing to retire".
 *
 * The walked set is derived from the tree — every tracked wrangler*.json(c) —
 * not check-worker-deploys' WORKER_CONFIGS, which owns the four backend
 * deploys and nothing else: apps/ui/wrangler.jsonc, the live `metagraphed-ui`
 * Worker on metagraph.sh, sat outside that list from the day this gate
 * landed, and a Worker added tomorrow is walked the moment its config is
 * tracked instead of dodging a hand list.
 */
export function d1RetirementFindings(name: string, raw: string): string[] {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(raw));
  } catch {
    return [`${name}: unreadable wrangler config counts as a live D1 consumer`];
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    return [`${name}: unreadable wrangler config counts as a live D1 consumer`];
  const sections: [string, unknown][] = [["", config]];
  const envs = (config as { env?: unknown }).env;
  if (envs && typeof envs === "object")
    for (const [envName, section] of Object.entries(envs))
      sections.push([`env.${envName}.`, section]);
  const findings: string[] = [];
  for (const [prefix, section] of sections) {
    if (!section || typeof section !== "object") continue;
    const bag = section as {
      d1_databases?: unknown;
      vars?: Record<string, unknown>;
    };
    const bindings = bag.d1_databases ?? [];
    if (!Array.isArray(bindings)) {
      // A d1_databases that is not an array is schema-invalid, which is the
      // parse-failure contract, not the no-bindings one.
      findings.push(
        `${name}: unreadable wrangler config counts as a live D1 consumer`,
      );
    } else {
      for (const entry of bindings as readonly ({
        binding?: string;
        database_name?: string;
      } | null)[])
        findings.push(
          `${name}: ${prefix}d1_databases binds ${entry?.binding ?? "?"} (${entry?.database_name ?? "?"})`,
        );
    }
    const tables = bag.vars?.D1_STATE_TABLES;
    if (typeof tables === "string" && tables.trim().length)
      findings.push(
        `${name}: ${prefix}vars.D1_STATE_TABLES owns ${
          tables.split(",").filter((table) => table.trim().length).length
        } tables`,
      );
    if (bag.vars?.D1_EXPORT_REVISIONS === "enabled")
      findings.push(`${name}: ${prefix}vars.D1_EXPORT_REVISIONS is enabled`);
  }
  return findings;
}

/**
 * Every deployed Worker's config, derived from the tree: all tracked files
 * named wrangler*.json or wrangler*.jsonc. The reach is stated as this
 * derivation so a drop reads as "it stopped looking": an empty enumeration or
 * a git failure throws instead of validating nothing. The floor is tracked
 * files under that name — an untracked or generated config (the UI preview
 * pipeline's wrangler.preview.json) is outside it, and every deploy pipeline
 * reads a tracked config as its source of truth.
 */
export function trackedWranglerConfigs(): string[] {
  const listed = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", ":(glob)**/wrangler*.json*"],
    { encoding: "utf8" },
  );
  const configs = (listed.stdout || "").split("\0").filter(Boolean);
  if (listed.status !== 0 || configs.length === 0)
    throw new Error(
      "d1-retirement: git ls-files found no wrangler configs; refusing to validate nothing",
    );
  return configs;
}

/** Read one deployed wrangler config. Only an absent file (ENOENT) reads as
 * retired; any other read failure throws, and main() counts that config as a
 * live consumer — an unreadable config must never read as nothing to retire,
 * at the filesystem layer exactly as at the parse layer. */
function loadConfig(config: string): string | null {
  try {
    return readFileSync(path.join(repoRoot, config), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Bare mode is the retirement step's refusal: exit 1 while any deployed store
 * falls through (metagraphed-infra#887 runs `node
 * scripts/validate-d1-retirement.ts`). `--pre-cutover` is the era guard CI and
 * the local gate run until the cutover config lands: exit 0 exactly while the
 * fallthrough still exists, and exit 1 the moment it does not — so the cutover
 * diff that drops the D1 bindings must also drop the flag here, flipping this
 * same program into the always-on proof that nothing reintroduces D1. A config
 * that cannot be read exits 1 in both modes: bare because it may hide a live
 * consumer, pre-cutover because an unknown is not a declared fallthrough.
 */
export function main(
  preCutover = false,
  load = loadConfig,
  configs: readonly string[] = trackedWranglerConfigs(),
): number {
  const unreadable: string[] = [];
  const findings = configs.flatMap((config) => {
    let raw: string | null;
    try {
      raw = load(config);
    } catch {
      unreadable.push(
        `${config}: unreadable wrangler config counts as a live D1 consumer`,
      );
      return [];
    }
    return raw === null ? [] : d1RetirementFindings(config, raw);
  });
  if (unreadable.length) {
    process.stderr.write(
      `d1-retirement: configs could not be read — fix the read before trusting any verdict:\n${unreadable.join("\n")}\n`,
    );
    return 1;
  }
  if (preCutover) {
    if (findings.length) {
      process.stdout.write(
        `d1-retirement (pre-cutover): ${findings.length} declared fallthroughs still deployed, as this era expects\n`,
      );
      return 0;
    }
    process.stderr.write(
      "d1-retirement (pre-cutover): no deployed store falls through — the cutover landed; drop --pre-cutover " +
        "from package.json's validate:d1-retirement and flip the era test in tests/d1-retirement.test.ts\n",
    );
    return 1;
  }
  if (findings.length) {
    process.stderr.write(
      `D1 retirement refused — deployed stores still fall through:\n${findings.join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    "d1-retirement: no deployed store falls through to D1\n",
  );
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(main(process.argv.includes("--pre-cutover")));
