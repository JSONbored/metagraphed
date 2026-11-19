import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WORKER_CONFIGS } from "./check-worker-deploys.ts";
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
      d1_databases?: readonly { binding?: string; database_name?: string }[];
      vars?: Record<string, unknown>;
    };
    for (const entry of bag.d1_databases ?? [])
      findings.push(
        `${name}: ${prefix}d1_databases binds ${entry.binding ?? "?"} (${entry.database_name ?? "?"})`,
      );
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
export function main(preCutover = false, load = loadConfig): number {
  const unreadable: string[] = [];
  const findings = WORKER_CONFIGS.flatMap((config) => {
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
