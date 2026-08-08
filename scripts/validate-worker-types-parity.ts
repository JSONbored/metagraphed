import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

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
// The fix for any failure here is always the same: `npm run types:workers`,
// then commit all three files.

export interface WorkerConfig {
  /** The wrangler config, relative to the repo root. */
  config: string;
  /** The generated types file it writes, relative to the repo root. */
  types: string;
}

export const WORKERS: WorkerConfig[] = [
  { config: "wrangler.jsonc", types: "workers/worker-configuration.d.ts" },
  {
    config: "wrangler.data.jsonc",
    types: "workers/data-api.worker-configuration.d.ts",
  },
  {
    config: "wrangler.registry.jsonc",
    types: "workers/registry-sync-api.worker-configuration.d.ts",
  },
];

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
 * JSONC -> JSON. Wrangler's configs carry `//` comments and trailing commas,
 * neither of which JSON.parse accepts. String-aware so a `//` inside a URL
 * (CHAIN_HEAD_RPC_URL is one) is not mistaken for a comment.
 */
export function parseJsonc(source: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<
    string,
    unknown
  >;
}

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
      config = parseJsonc(
        await fs.readFile(path.join(repoRoot, worker.config), "utf8"),
      );
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
  }

  if (errors.length > 0) {
    console.error(
      `Generated Worker Env types are stale:\n${errors.map((line) => `  - ${line}`).join("\n")}\n\nRun \`npm run types:workers\` and commit all three files.`,
    );
    process.exit(1);
  }

  console.log(
    `Worker Env types match their wrangler configs (${WORKERS.length} workers).`,
  );
}
