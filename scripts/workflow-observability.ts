// Keeps GitHub Actions' error reporting from silently rotting back off.
//
// scripts/observability.ts is the only place in the tree with real PostHog
// flush semantics (captureExceptionImmediate + shutdown on the fatal path),
// but initObservability() RETURNS EARLY when POSTHOG_PROJECT_TOKEN is unset.
// That is the right behavior for a local run -- and it is exactly why the
// instrumentation was dead in CI for as long as it was: every instrumented
// script ran in Actions with the var absent, so every one of them was a
// no-op, and nothing anywhere said so. A missing env line looks identical to
// a working one until the day you need the error report.
//
// So the pairing is enforced rather than documented: a workflow step that
// reaches an instrumented script must have POSTHOG_PROJECT_TOKEN in scope.
// Both halves are derived from the tree, never hand-listed -- a script that
// gains an `import ... from "./observability.ts"` tomorrow is covered the
// moment it does, with no list to remember to update.
//
// The two indirections that make this worth computing instead of grepping:
//
//  1. `npm run <name>` hides the script path behind package.json.
//  2. scripts/build.ts is a step RUNNER, and it has two step lists. Only
//     productionSteps() includes the instrumented native-snapshot and
//     refresh-og-image; localSteps() includes neither. Which one runs is
//     decided by METAGRAPH_PRODUCTION_BUILD, so a plain `npm run build` in
//     validate.yml genuinely does not need the token and must not be flagged
//     -- treating both lists alike would have failed nine honest steps.
//
// The functions here are pure (they take sources, not paths) so the rule can
// be tested against synthetic workflows -- including the NEGATIVE case, that
// it actually fails a step missing the var. A guard that has only ever been
// watched passing is not a guard.

export const OBSERVABILITY_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN";
export const PRODUCTION_BUILD_ENV = "METAGRAPH_PRODUCTION_BUILD";

// `import { ... } from "./observability.ts"` in any spacing/multi-line form.
const OBSERVABILITY_IMPORT = /from\s+"\.\/observability\.ts"/;
const SCRIPT_PATH = /scripts\/[\w.-]+\.(?:ts|mjs|js)/g;
const NPM_RUN = /npm\s+run\s+([\w:-]+)/g;
// scripts/build.ts declares its child steps as nodeStep("name", "scripts/x.ts").
// Parsed from that declaration rather than by scanning build.ts for any script
// path, so a path merely MENTIONED in a comment is not mistaken for a step.
const BUILD_NODE_STEP = /nodeStep\(\s*"[^"]*"\s*,\s*"(scripts\/[\w.-]+\.ts)"/g;

export type ReachContext = {
  /** package.json's `scripts` map, for resolving `npm run <name>`. */
  npmScripts: Record<string, string>;
  /** script path -> the scripts it spawns as children. */
  spawnedBy: Map<string, Set<string>>;
};

/** The scripts that import scripts/observability.ts, keyed by repo-relative path. */
export function instrumentedScripts(
  scriptSources: Map<string, string>,
): Set<string> {
  const instrumented = new Set<string>();
  for (const [scriptPath, source] of scriptSources) {
    if (scriptPath.endsWith("scripts/observability.ts")) continue;
    if (OBSERVABILITY_IMPORT.test(source)) instrumented.add(scriptPath);
  }
  return instrumented;
}

/**
 * scripts/build.ts's two step lists, read from the functions that declare
 * them. Kept separate because only the production list runs instrumented
 * scripts -- see the header.
 */
export function buildStepScripts(buildSource: string): {
  local: Set<string>;
  production: Set<string>;
} {
  return {
    local: nodeStepScripts(functionBody(buildSource, "localSteps")),
    production: nodeStepScripts(functionBody(buildSource, "productionSteps")),
  };
}

function nodeStepScripts(source: string): Set<string> {
  const scripts = new Set<string>();
  for (const [, scriptPath] of source.matchAll(BUILD_NODE_STEP)) {
    scripts.add(scriptPath);
  }
  return scripts;
}

/** A top-level `function name(): Step[] { ... }` body, to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = source.indexOf("\n}", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/**
 * Every script a shell command reaches: named directly, reached through
 * `npm run <name>`, or spawned as a child by a script that is itself reached.
 */
export function scriptsReachedBy(
  command: string,
  ctx: ReachContext,
): Set<string> {
  const reached = new Set<string>();
  const commands = [command];
  const seenNpmScripts = new Set<string>();
  while (commands.length > 0) {
    const current = commands.pop() as string;
    for (const [scriptPath] of current.matchAll(SCRIPT_PATH)) {
      reached.add(scriptPath);
    }
    for (const [, name] of current.matchAll(NPM_RUN)) {
      // Guarded against an npm script that (directly or in a cycle) runs
      // itself -- resolution must terminate, not stack-overflow CI.
      if (seenNpmScripts.has(name)) continue;
      seenNpmScripts.add(name);
      const body = ctx.npmScripts[name];
      if (body) commands.push(body);
    }
  }
  const pending = [...reached];
  while (pending.length > 0) {
    const script = pending.pop() as string;
    for (const child of ctx.spawnedBy.get(script) ?? []) {
      if (reached.has(child)) continue;
      reached.add(child);
      pending.push(child);
    }
  }
  return reached;
}

/**
 * Every `- name:` step in a workflow, as {name, block, index}.
 *
 * Enumerated rather than looked up by literal, so a rule can select steps by
 * what they DO -- which upload carries the token -- instead of by what they are
 * called. Names are prose and get rewritten; the contract should not move with
 * them. Quoted names are unwrapped, since YAML requires quoting once a name
 * contains a colon.
 */
export function workflowSteps(
  content: string,
): { name: string; block: string; index: number }[] {
  const steps: { name: string; block: string; index: number }[] = [];
  // Six spaces is the indent a step sits at inside jobs.<id>.steps. Written as {6}
  // rather than as literal spaces so the count is readable and cannot be miscounted
  // by eye -- which is exactly what no-regex-spaces is for.
  const marker = /^ {6}- name: (.+)$/gm;
  const starts: { name: string; index: number }[] = [];
  for (const m of content.matchAll(marker)) {
    starts.push({
      name: m[1].trim().replace(/^["'](.*)["']$/, "$1"),
      index: m.index ?? 0,
    });
  }
  for (const [i, step] of starts.entries()) {
    steps.push({
      name: step.name,
      index: step.index,
      block: content.slice(step.index, starts[i + 1]?.index),
    });
  }
  return steps;
}

/** Each job's byte range, so a step can be resolved to the job that encloses it. */
function jobRanges(content: string): { start: number; end: number }[] {
  const starts: number[] = [];
  for (const m of content.matchAll(/^ {2}[A-Za-z0-9_-]+:$/gm)) {
    starts.push(m.index ?? 0);
  }
  return starts.map((start, i) => ({
    start,
    end: starts[i + 1] ?? content.length,
  }));
}

/**
 * Whether `name` is set for a step, at any of the three levels GitHub merges:
 * the step's own `env:` (keys at 10 spaces), the enclosing job's (6), or the
 * workflow's (2). Hoisting a var to the job is a legitimate way to set it --
 * publish-cloudflare.yml already does exactly that with
 * METAGRAPH_PRODUCTION_BUILD -- so a rule that only looked at the step would
 * be wrong about the repo as it already stands.
 */
function envInScope(
  name: string,
  content: string,
  step: { block: string; index: number },
): boolean {
  if (step.block.includes(`${name}:`)) return true;
  if (new RegExp(String.raw`^ {2}${name}:`, "m").test(content)) return true;
  const job = jobRanges(content).find(
    (range) => step.index >= range.start && step.index < range.end,
  );
  if (!job) return false;
  return new RegExp(String.raw`^ {6}${name}:`, "m").test(
    content.slice(job.start, job.end),
  );
}

/**
 * Steps that reach an instrumented script without POSTHOG_PROJECT_TOKEN in
 * scope -- i.e. steps whose error reporting would silently do nothing.
 */
export function stepsMissingObservabilityToken(
  content: string,
  ctx: {
    npmScripts: Record<string, string>;
    buildStepScripts: { local: Set<string>; production: Set<string> };
    instrumented: Set<string>;
  },
): { step: string; scripts: string[] }[] {
  const missing: { step: string; scripts: string[] }[] = [];
  for (const step of workflowSteps(content)) {
    const spawnedBy = new Map([
      [
        "scripts/build.ts",
        envInScope(PRODUCTION_BUILD_ENV, content, step)
          ? ctx.buildStepScripts.production
          : ctx.buildStepScripts.local,
      ],
    ]);
    const scripts = [
      ...scriptsReachedBy(step.block, {
        npmScripts: ctx.npmScripts,
        spawnedBy,
      }),
    ]
      .filter((scriptPath) => ctx.instrumented.has(scriptPath))
      .sort();
    if (scripts.length === 0) continue;
    if (envInScope(OBSERVABILITY_TOKEN_ENV, content, step)) continue;
    missing.push({ step: step.name, scripts });
  }
  return missing;
}
