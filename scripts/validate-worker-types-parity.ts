import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot, stripJsonComments } from "./lib.ts";

// Drift gate for the three generated Worker Env files (#10188).
//
// WHY THIS IS A PARITY CHECK AND NOT A REGENERATE-AND-DIFF. Every sibling
// drift gate (validate-graphql-types-drift, validate-generated-client) reruns
// its generator and compares byte for byte, and that is the shape this wanted
// to be. `wrangler types` cannot do it: the output PATH is baked into the file
// -- both into the header comment and into the `mainModule` import specifier --
// so regenerating anywhere but the committed path produces a file that differs
// for reasons that are not drift. Regenerating IN PLACE would work but mutates
// tracked files as a side effect of a validator, which `npm run check` should
// not do.
//
// So this asserts the INVARIANT that actually broke in #10186 instead: every
// var declared in a wrangler config appears in that config's generated types
// with the SAME literal, and every declared binding appears by name. That is
// three real failure modes, all of which had landed:
//
//   1. data-api's file carried no vars at all beyond UNKEY_API_ID -- ten
//      missing, including all three NEON_* lane lists.
//   2. SYNC_BATCHES (a Queue) was missing entirely, so a real binding was
//      untyped.
//   3. Every METAGRAPH_*_SOURCE literal read "postgres" while the config had
//      moved to "d1"/"retired" -- the dangerous one, because a stale literal
//      SUPPRESSES type errors rather than causing them. `env.X === "postgres"`
//      type-checked cleanly while being unreachable, which is how six dead
//      branches accumulated invisibly.
//
// What it deliberately does NOT check is the runtime-types block, whose
// workerd build stamp moves with the pinned dependency rather than with repo
// content. A Wrangler bump that leaves vars and bindings alone is not drift
// this gate should fail on.
//
// JSONC parsing is scripts/lib.ts's stripJsonComments -- the same helper
// scripts/cloudflare-verify.ts already reads wrangler.jsonc with. It is
// string-aware for both comment forms AND trailing commas. The first cut of
// this file carried its own copy that stripped trailing commas with a regex
// over the whole document, which would have corrupted any var whose VALUE
// contained `,}` (POSTHOG_USAGE_SAMPLE_RATES is an embedded JSON object, so
// that was one config edit away from biting).
//
// The fix for any failure here is always the same: `npm run types:workers`,
// then commit every generated file.

export interface WorkerConfig {
  /** The wrangler config, relative to the repo root. */
  config: string;
  /** The generated types file it writes, relative to the repo root. */
  types: string;
  /**
   * The interface name that file must declare.
   *
   * DISTINCT PER WORKER, and the reason this field exists (#11339). Every
   * generated file used to end with a top-level `interface Env`, and
   * TypeScript merges all top-level declarations of one name across the
   * program -- so four separately generated envs collapsed into a single
   * `Env` that was the UNION of all four. `registry-sync`'s env advertised
   * data-api's `METAGRAPH_CONTROL`; data-api's advertised registry-sync's
   * rate limiter; and `POSTHOG_TRACES_SAMPLE_RATE`, a different literal in
   * two configs, resolved to `string | undefined` -- so the literal check
   * below, whose whole point is that "a stale literal SUPPRESSES type errors",
   * was already blind to any var that differed between configs.
   *
   * `skipLibCheck: true` hides the conflicting redeclaration, which is why
   * none of this ever surfaced as an error.
   */
  envInterface: string;
}

export const WORKERS: WorkerConfig[] = [
  {
    config: "wrangler.jsonc",
    types: "workers/worker-configuration.d.ts",
    // The main API Worker keeps the bare name: `src/**` shared code means this
    // one when it says `Env`, and 841 parameters across 150 files say it.
    envInterface: "Env",
  },
  {
    config: "wrangler.data.jsonc",
    types: "workers/data-api.worker-configuration.d.ts",
    envInterface: "DataApiEnv",
  },
  {
    config: "wrangler.registry.jsonc",
    types: "workers/registry-sync-api.worker-configuration.d.ts",
    envInterface: "RegistrySyncApiEnv",
  },
  // #10861: the fourth, and the one this list was missing. Every wrangler
  // config in the repo belongs here -- an omission is invisible, because a
  // Worker with no generated types has nothing for the gate to disagree with.
  {
    config: "wrangler.wss-lb.jsonc",
    types: "workers/wss-lb.worker-configuration.d.ts",
    envInterface: "WssLbWorkerEnv",
  },
];

/**
 * Each generated file must declare ITS OWN interface name.
 *
 * THE INVARIANT THIS GATE WAS MISSING (#11339). `wrangler types` names the
 * interface `Env` unless told otherwise, and every top-level `interface Env`
 * in the program merges into one. Four separately generated envs therefore
 * became a single union: every Worker's env advertised every other Worker's
 * bindings, and a `env.SOME_OTHER_WORKERS_QUEUE` reference typed cleanly and
 * was `undefined` at runtime -- exactly the class #10186 was filed for, one
 * level up.
 *
 * It also silently defeated the literal check below. `POSTHOG_TRACES_SAMPLE_RATE`
 * is "0.002" in wrangler.data.jsonc and "1" in wrangler.registry.jsonc;
 * merged, it resolved to `string | undefined`, so the check that exists
 * because "a stale literal SUPPRESSES type errors" could not see any var whose
 * value differed between configs.
 *
 * Regenerating without `--env-interface` is the one-command way to undo all of
 * that, and it produces no error of its own -- `skipLibCheck: true` hides the
 * conflicting redeclaration. Hence a gate.
 */
export function envInterfaceErrors(
  worker: WorkerConfig,
  types: string,
): string[] {
  const declared = [...types.matchAll(/^interface (\w+) extends /gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("__BaseEnv_"));
  if (declared.includes(worker.envInterface)) return [];
  return [
    `${worker.types} declares ${declared.length ? declared.join(", ") : "no env interface"}, ` +
      `not \`${worker.envInterface}\`. Every generated file naming its interface ` +
      `\`Env\` merges them into one union, so each Worker's env advertises every ` +
      `other Worker's bindings. Regenerate with ` +
      `\`--env-interface ${worker.envInterface}\` (the \`types:workers\` script does).`,
  ];
}

/**
 * EVERY wrangler config must appear in WORKERS above (#10861).
 *
 * `wss-lb` sat outside this list from the day it was added, and nothing could
 * report that: the gate only compares configs it was told about, so a missing
 * entry is a silent exemption rather than a failure. It cost the balancer
 * literal-typed vars for its whole life -- `workers/wss-lb.ts` hand-wrote
 * `WssLbEnv` with every field `?: string`, so deleting a var from the config
 * still compiled and the code's fallbacks quietly took over.
 *
 * This is the same shape as the exemption lists this repo has been bitten by
 * before: what a checker does not enumerate, it cannot check. So the roster is
 * derived from the filesystem and compared, rather than trusted.
 */
export function findUnlistedConfigs(rootFiles: string[]): string[] {
  const listed = new Set(WORKERS.map((w) => w.config));
  return rootFiles
    .filter((f) => /^wrangler(\..+)?\.jsonc$/.test(f))
    .filter((f) => !listed.has(f))
    .sort();
}

/** Binding blocks whose entries carry a `binding` (or `name`) to declare. */
const BINDING_KEYS = [
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "queues",
  "hyperdrive",
  "vectorize",
  "analytics_engine_datasets",
  "durable_objects",
  "services",
  "ratelimits",
  "ai",
  "browser",
  "mtls_certificates",
  "dispatch_namespaces",
  "send_email",
  "version_metadata",
] as const;

/**
 * Every binding name a config declares, across all the binding blocks.
 *
 * Three shapes are in play and all three are live in this repo, which is why
 * this flattens rather than assuming an array: `kv_namespaces` and friends are
 * arrays of `{ binding }`; `ai` / `version_metadata` are a single `{ binding }`
 * object; and `queues` / `durable_objects` nest their entries one level down
 * (`producers` + `consumers`, `bindings`). SYNC_BATCHES is a queue PRODUCER --
 * the exact binding #10186 found untyped -- so missing the nested case would
 * have left this gate blind to the failure that motivated it.
 *
 * The KEY also varies: most blocks name it `binding`, but `durable_objects`
 * and `ratelimits` both use `name`. Reading only `binding` silently skipped
 * all six DO namespaces and all eleven rate limiters -- caught by deleting a
 * DO line and watching this gate stay green, which is the only way to know a
 * check of this shape actually checks anything.
 */
export function declaredBindings(config: Record<string, unknown>): string[] {
  const names: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry, depth);
      return;
    }
    const record = value as Record<string, unknown>;
    const declared = record.binding ?? record.name;
    if (typeof declared === "string" && declared) {
      names.push(declared);
      return;
    }
    // A wrapper block (queues.producers, durable_objects.bindings). One level
    // only: binding entries never nest deeper, and recursing freely would
    // start collecting unrelated `binding`-named keys from settings blocks.
    if (depth === 0)
      for (const nested of Object.values(record)) collect(nested, 1);
  };
  for (const key of BINDING_KEYS) collect(config[key]);
  return names;
}

/**
 * Every parity failure between one config and its generated types.
 *
 * Pure so it can be tested against fixtures rather than only against the repo's
 * own (currently correct) files -- a gate whose only evidence is "it passes on
 * a clean tree" has not been shown to detect anything.
 */
export function workerTypesParityErrors(
  worker: WorkerConfig,
  config: Record<string, unknown>,
  types: string,
): string[] {
  const errors: string[] = [];
  const vars = (config.vars ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(vars)) {
    // Only string vars get a literal type; wrangler widens the rest.
    if (typeof value !== "string") continue;
    // The exact line wrangler emits, e.g. `\tFOO: "bar";`. JSON.stringify gives
    // wrangler's own escaping for quotes and backslashes, which
    // POSTHOG_USAGE_SAMPLE_RATES (an embedded JSON object) depends on.
    if (types.includes(`${name}: ${JSON.stringify(value)};`)) continue;
    const declared = new RegExp(`\\b${name}:\\s*("[^"]*"|string);`).exec(types);
    errors.push(
      declared
        ? `${worker.types}: ${name} is typed \`${declared[1]}\` but ${worker.config} sets ${JSON.stringify(value)}.`
        : `${worker.types}: ${name} is missing (${worker.config} sets ${JSON.stringify(value)}).`,
    );
  }
  for (const binding of declaredBindings(config)) {
    if (new RegExp(`\\b${binding}\\s*:`).test(types)) continue;
    errors.push(
      `${worker.types}: binding ${binding} is missing (declared in ${worker.config}).`,
    );
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors: string[] = [];
  for (const worker of WORKERS) {
    let config: Record<string, unknown>;
    let types: string;
    try {
      config = JSON.parse(
        stripJsonComments(
          await fs.readFile(path.join(repoRoot, worker.config), "utf8"),
        ),
      ) as Record<string, unknown>;
    } catch (error) {
      errors.push(`${worker.config}: could not parse (${String(error)})`);
      continue;
    }
    try {
      types = await fs.readFile(path.join(repoRoot, worker.types), "utf8");
    } catch {
      errors.push(
        `${worker.types} is missing. Run \`npm run types:workers\` and commit it.`,
      );
      continue;
    }
    errors.push(...workerTypesParityErrors(worker, config, types));
    errors.push(...envInterfaceErrors(worker, types));
  }

  // The roster itself, checked against the filesystem (#10861). Without this a
  // new Worker joins the repo untyped and ungated, and the only symptom is a
  // number in this script's own success line that nobody reads.
  for (const unlisted of findUnlistedConfigs(await fs.readdir(repoRoot))) {
    errors.push(
      `${unlisted} is not in WORKERS, so nothing generates or checks its Env types. Add it to WORKERS and to the \`types:workers\` script.`,
    );
  }

  if (errors.length > 0) {
    console.error(
      `Generated Worker Env types are stale:\n${errors.map((line) => `  - ${line}`).join("\n")}\n\nRun \`npm run types:workers\` and commit every generated file.`,
    );
    process.exit(1);
  }

  console.log(
    `Worker Env types match their wrangler configs (${WORKERS.length} workers).`,
  );
}
