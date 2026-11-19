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

export function main(): number {
  const findings = WORKER_CONFIGS.flatMap((config) => {
    let raw: string;
    try {
      raw = readFileSync(path.join(repoRoot, config), "utf8");
    } catch {
      // A config this repo no longer deploys has no D1 left to retire.
      return [];
    }
    return d1RetirementFindings(config, raw);
  });
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
  process.exit(main());
