// What the served payloads carry that their schemas do not declare (#10790).
//
// 343 `.passthrough()` against 575 `.strict()`: 37% of the contract accepts
// fields it never declared. `SubnetUptime.observed_at` is the worked example
// (#10761) -- `formatUptime` emitted it on every card, both transports fed it,
// REST read it back into the response meta, and `UptimeArtifactSchema` never
// declared it. `.passthrough()` is why nothing noticed, for months.
//
// The benign reading is drift. The other reading is the same mechanism: a
// producer that starts emitting an internal field ships it to clients, past a
// response tripwire that validates the declared fields and waves the rest
// through. `safeParse` over `.passthrough()` is a leak guard that does not
// guard.
//
// ## Report only, and measured before anything is enforced
//
// Flipping 343 schemas blind breaks things, and the breakage is
// indistinguishable from the leak it is meant to find. So this REPORTS: for
// every built artifact, it walks the payload beside the schema that publishes
// it and lists the keys the schema has no field for. Nothing is parsed
// strictly, nothing throws, nothing is served differently.
//
// ## Why the built artifacts rather than a production probe
//
// `npm run build` writes 2,357 of them, and they ARE the served surface: the
// R2 tier serves these bytes. Reading them offline covers every subnet and
// every per-subnet card in one pass -- where a probe covers whatever the
// prober thought to ask for, and (the lesson of #10786) covers only the happy
// path, because production is not degraded when you ask it.
//
// A field is reported per COMPONENT and per PATH inside it, not per file, so
// one field emitted on 128 subnet cards is one finding rather than 128.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { COMPONENT_SCHEMAS_BY_ID } from "../schemas-src/openapi-registry.ts";
import { PUBLIC_ARTIFACTS } from "../src/contracts.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Where `npm run build` stages the R2 tier, and where the git tier lands. */
const ARTIFACT_ROOTS = [
  "dist/metagraph-r2/metagraph",
  "public/metagraph",
] as const;

/** One undeclared field, and where it was seen. */
export interface UndeclaredField {
  /** `SubnetUptimeArtifact.observed_at`, or `….rows[].extra` for a nested one. */
  path: string;
  /** How many payload objects carried it. */
  seen: number;
  /** A value, so the triage decision has something to look at. */
  sample: unknown;
  /** The first artifact it appeared in. */
  artifact: string;
}

export interface UndeclaredReport {
  /**
   * Keys a `.strict()` schema REJECTS that the payload carries anyway.
   *
   * A served artifact that fails its own contract. Empty is the only
   * acceptable value, and this is the class the `.passthrough()` migration
   * could have created if it had been flipped without measuring.
   */
  violations: UndeclaredField[];
  findings: UndeclaredField[];
  /** Artifacts walked against a component. */
  walked: number;
  /** Artifacts with no component to walk against. */
  unmapped: number;
  /** Objects compared against a declared shape. */
  objects: number;
  /** Keys accepted by a schema that DECLARES itself open, with a reason. */
  declaredOpen: number;
}

/**
 * Peel the wrappers that do not change which keys an object may carry.
 *
 * `z.lazy` is peeled through its `getter`, NOT through `innerType` -- it has no
 * `innerType`, so a walk that only followed that one stopped dead at every
 * lazy component and reported it clean. `ReviewQueueArtifact` is behind one
 * (`z.lazy(() => CandidatesArtifactSchema)`), which is how a first pass of this
 * report answered zero for an artifact that `validate:schemas` then rejected.
 */
function unwrap(schema: z.ZodType): z.ZodType {
  type Wrapper = { innerType?: z.ZodType; getter?: () => z.ZodType };
  let current = schema;
  for (let hops = 0; hops < 12; hops += 1) {
    const def = current.def as Wrapper;
    const inner = def.innerType ?? (def.getter ? def.getter() : undefined);
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/**
 * What this object schema says about a key it does not declare.
 *
 *   "rejects"  `.strict()` -- a `never` catchall. The payload cannot carry one:
 *              it would fail the response tripwire before reaching a client.
 *   "declared" an explicit `.catchall(...)`. Extra keys ARE the contract here,
 *              and the four sites that use it carry a written reason and an
 *              entry in scripts/validate-schema-opacity.ts.
 *   "silent"   a bare `z.object()`, or the `.passthrough()` this issue removed.
 *              The key is served (passthrough) or dropped (strip) with nothing
 *              in the contract either way, which is the whole defect.
 */
function undeclaredKeyPolicy(
  schema: z.ZodObject,
): "rejects" | "declared" | "silent" {
  const catchall = (schema.def as { catchall?: z.ZodType }).catchall;
  if (!catchall) return "silent";
  return catchall.def.type === "never" ? "rejects" : "declared";
}

/** Walk `value` beside `schema`, recording keys the schema has no field for. */
export function findUndeclared(
  schema: z.ZodType,
  value: unknown,
  where: string,
  artifact: string,
  found: Map<string, UndeclaredField>,
  violations: Map<string, UndeclaredField>,
  counters: { objects: number; declaredOpen: number },
): void {
  const node = unwrap(schema);
  const kind = node.def.type;

  if (kind === "union") {
    // A value that satisfies ANY arm is declared by that arm. Reporting the
    // arms that reject it would manufacture a finding per alternative.
    const options = (node.def as { options?: readonly z.ZodType[] }).options;
    const match = options?.find((option) => option.safeParse(value).success);
    if (match) {
      findUndeclared(
        match,
        value,
        where,
        artifact,
        found,
        violations,
        counters,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    const element = (node.def as { element?: z.ZodType }).element;
    if (!element) return;
    for (const item of value) {
      findUndeclared(
        element,
        item,
        `${where}[]`,
        artifact,
        found,
        violations,
        counters,
      );
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  if (kind === "record") {
    const valueType = (node.def as { valueType?: z.ZodType }).valueType;
    if (!valueType) return;
    for (const entry of Object.values(value)) {
      findUndeclared(
        valueType,
        entry,
        `${where}{}`,
        artifact,
        found,
        violations,
        counters,
      );
    }
    return;
  }

  if (kind !== "object") return;
  const object = node as z.ZodObject;
  const shape = object.shape;
  counters.objects += 1;
  for (const [key, entry] of Object.entries(value)) {
    const field = shape[key] as z.ZodType | undefined;
    if (field) {
      findUndeclared(
        field,
        entry,
        `${where}.${key}`,
        artifact,
        found,
        violations,
        counters,
      );
      continue;
    }
    const policy = undeclaredKeyPolicy(object);
    if (policy === "declared") {
      counters.declaredOpen += 1;
      continue;
    }
    // `.strict()` REJECTS the key, and the payload has it anyway: this artifact
    // fails its own contract. Before the migration that combination could not
    // exist, so an earlier draft of this report skipped it as unreachable --
    // and skipping it is precisely what would have let the flip ship broken.
    // `ReviewQueueArtifact.count` was found this way, by `validate:schemas`
    // rather than by the report that exists to find it first.
    const id = `${where}.${key}`;
    if (policy === "rejects") {
      const existing = violations.get(id);
      if (existing) existing.seen += 1;
      else violations.set(id, { path: id, seen: 1, sample: entry, artifact });
      continue;
    }
    const existing = found.get(id);
    if (existing) existing.seen += 1;
    else found.set(id, { path: id, seen: 1, sample: entry, artifact });
  }
}

/** Every `.json` under `dir`, recursively. */
function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJson(full));
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

/** Every built artifact, as `[published artifact path, parsed body]`. */
function artifacts(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const root of ARTIFACT_ROOTS) {
    const absolute = path.join(repoRoot, root);
    for (const file of walkJson(absolute)) {
      const relative = path.relative(absolute, file).split(path.sep).join("/");
      out.push([
        `/metagraph/${relative}`,
        JSON.parse(readFileSync(file, "utf8")),
      ]);
    }
  }
  return out;
}

/**
 * The component a CONCRETE artifact path publishes, or null.
 *
 * `schemaRefForArtifactPath` matches a contract's path template against
 * another TEMPLATE -- right for the OpenAPI emitter that owns it, and the
 * wrong question here: the built tree holds `/metagraph/subnets/5/uptime.json`,
 * not `/metagraph/subnets/{netuid}/uptime.json`. Matching only the exact form
 * would have walked 49 artifacts of 2,363 and reported a clean bill of health
 * for the per-subnet cards, which is where `SubnetUptime.observed_at` -- this
 * issue's worked example -- actually lives.
 */
function componentFor(artifactPath: string): string | null {
  // The network twin publishes the SAME components under a `testnet/` prefix
  // (`networkArtifactPath`), and 548 of the 2,363 built artifacts are it.
  // Leaving them unmapped would have called the measurement complete while a
  // quarter of the tree went unread.
  const canonical = artifactPath.replace(
    /^\/metagraph\/testnet\//,
    "/metagraph/",
  );
  for (const contract of PUBLIC_ARTIFACTS) {
    if (!contract.schema_ref) continue;
    const pattern = new RegExp(
      `^${contract.path
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{[a-z_]+\\\}/g, "[^/]+")}$`,
    );
    if (pattern.test(canonical)) return contract.schema_ref;
  }
  return null;
}

export function runReport(): UndeclaredReport {
  const found = new Map<string, UndeclaredField>();
  const violations = new Map<string, UndeclaredField>();
  const counters = { objects: 0, declaredOpen: 0 };
  let walked = 0;
  let unmapped = 0;
  for (const [artifactPath, body] of artifacts()) {
    // THROWS on an artifact no contract maps -- adapters, per-provider blobs
    // and the R2 manifest among them. That is the right behaviour for the
    // OpenAPI emitter that owns it and the wrong question for a report, which
    // is asking what the MAPPED payloads carry.
    const component = componentFor(artifactPath);
    const schema = component
      ? COMPONENT_SCHEMAS_BY_ID.get(component)
      : undefined;
    if (!schema) {
      unmapped += 1;
      continue;
    }
    walked += 1;
    findUndeclared(
      schema,
      body,
      component ?? "",
      artifactPath,
      found,
      violations,
      counters,
    );
  }
  return {
    violations: [...violations.values()].sort((a, b) => b.seen - a.seen),
    findings: [...found.values()].sort((a, b) => b.seen - a.seen),
    walked,
    unmapped,
    objects: counters.objects,
    declaredOpen: counters.declaredOpen,
  };
}

function main(): void {
  const report = runReport();
  console.log(
    `undeclared-fields: ${report.walked} artifact(s) walked against their ` +
      `component (${report.unmapped} have none), ${report.objects} object(s) ` +
      `compared; ${report.findings.length} field(s) served but not declared, ` +
      `${report.declaredOpen} accepted by a schema that declares itself open; ` +
      `${report.violations.length} REJECTED by their own schema.`,
  );
  if (report.violations.length) {
    console.log(
      "\nVIOLATIONS -- the schema is `.strict()` and the payload carries these anyway:",
    );
    for (const violation of report.violations) {
      console.log(
        `  ${violation.path}  x${violation.seen}  e.g. ${JSON.stringify(violation.sample)?.slice(0, 60)}  [${violation.artifact}]`,
      );
    }
  }
  for (const finding of report.findings) {
    console.log(
      `  ${finding.path}  x${finding.seen}  e.g. ${JSON.stringify(finding.sample)?.slice(0, 60)}  [${finding.artifact}]`,
    );
  }
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
