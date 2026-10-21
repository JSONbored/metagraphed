// Exact source variants for supplemental observations. This module never launches
// a runtime or service and does not alter the uninstrumented reference tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedFile } from "./receipt-files.ts";
import { verifyCandidate, sha256 } from "./verify-candidate.ts";
import {
  FAILURE_LIFECYCLE_SOURCE_PINS,
  FAILURE_LIFECYCLE_ACTIVE_PATHS,
  FAILURE_LIFECYCLE_UNFIXED_PATHS,
  instrumentFailureLifecycleSource,
  type FailureLifecycleSourcePath,
} from "./failure-lifecycle-source.ts";
export const FAILURE_PHASES = [
  "uninstrumented",
  "instrumented",
  "unfixed-instrumented",
] as const;
export type FailurePhase = (typeof FAILURE_PHASES)[number];
export const FAILURE_PHASE_PATH =
  "tests/qualification/strict-gzip/failure-phase.json";
const originalBase = "6b8422966b1411dff6d7c486f4e9a549acecc761";
const sourcePaths: readonly FailureLifecycleSourcePath[] =
  FAILURE_LIFECYCLE_ACTIVE_PATHS;
export function failurePhase(value: unknown): FailurePhase {
  assert.ok(FAILURE_PHASES.includes(value as FailurePhase));
  return value as FailurePhase;
}
export function phaseBytes(phase: FailurePhase): Buffer {
  failurePhase(phase);
  return Buffer.from(JSON.stringify({ phase }) + "\n");
}
function priorSource(
  base: string,
  logical: FailureLifecycleSourcePath,
): string {
  assert.ok(sourcePaths.includes(logical));
  const bytes = execFileSync(
    "git",
    ["-C", base, "show", `${originalBase}:${logical}`],
    {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(sha256(bytes), FAILURE_LIFECYCLE_SOURCE_PINS[logical].unfixed);
  return bytes.toString();
}
export function expectedVariantSource(
  logical: FailureLifecycleSourcePath,
  current: string,
  phase: FailurePhase,
  unfixed?: string,
) {
  failurePhase(phase);
  assert.ok(sourcePaths.includes(logical));
  assert.equal(
    sha256(Buffer.from(current)),
    FAILURE_LIFECYCLE_SOURCE_PINS[logical].fixed,
  );
  if (phase === "uninstrumented") return current;
  const variant = phase === "unfixed-instrumented" ? "unfixed" : "fixed";
  const before =
    variant === "unfixed" &&
    (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(logical)
      ? unfixed
      : current;
  assert.equal(typeof before, "string");
  return instrumentFailureLifecycleSource(logical, before!, variant).source;
}
function distinctRoots(reference: string, variant: string) {
  assert.ok(path.isAbsolute(reference) && path.isAbsolute(variant));
  assert.notEqual(reference, variant);
  assert.ok(
    !reference.startsWith(variant + path.sep) &&
      !variant.startsWith(reference + path.sep),
  );
}
function inventory(root: string, afterRun: boolean) {
  const result = new Map<
    string,
    { mode: number; link?: string; hash?: string }
  >();
  const ignored = new Set([
    "node_modules",
    ...(afterRun ? [".wrangler", ".mf", ".miniflare"] : []),
  ]);
  function walk(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && ignored.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
        file = path.join(directory, entry.name),
        stat = lstatSync(file);
      if (entry.isDirectory()) {
        assert.ok(!stat.isSymbolicLink());
        walk(file, relative);
      } else if (stat.isSymbolicLink())
        result.set(relative, {
          mode: stat.mode & 0o111,
          link: readlinkSync(file),
        });
      else {
        assert.ok(stat.isFile());
        result.set(relative, {
          mode: stat.mode & 0o111,
          hash: sha256(readFileSync(file)),
        });
      }
    }
  }
  walk(root);
  return result;
}
export function verifyFailureVariant(
  referenceDirectory: string,
  variantDirectory: string,
  baseDirectory: string,
  phase: FailurePhase,
  afterRun = false,
) {
  failurePhase(phase);
  const { root: reference, base } = verifyCandidate(
    referenceDirectory,
    baseDirectory,
    afterRun,
  );
  assert.ok(path.isAbsolute(variantDirectory));
  const variantStat = lstatSync(variantDirectory);
  assert.ok(variantStat.isDirectory() && !variantStat.isSymbolicLink());
  const variant = realpathSync(variantDirectory);
  assert.equal(variant, variantDirectory);
  distinctRoots(reference, variant);
  assert.equal(
    realpathSync(path.join(variant, "node_modules")),
    realpathSync(path.join(reference, "node_modules")),
  );
  const before = inventory(reference, afterRun),
    after = inventory(variant, afterRun);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  const transformed = [];
  for (const [logical, identity] of before) {
    const actual = after.get(logical)!;
    assert.equal(actual.mode, identity.mode);
    if (logical === FAILURE_PHASE_PATH) {
      assert.equal(actual.link, undefined);
      assert.equal(actual.hash, sha256(phaseBytes(phase)));
      continue;
    }
    if (sourcePaths.includes(logical as FailureLifecycleSourcePath)) {
      const sourcePath = logical as FailureLifecycleSourcePath;
      const current = boundedFile(
        path.join(reference, logical),
        1024 * 1024,
      ).toString();
      const unfixed =
        phase === "unfixed-instrumented" &&
        (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(logical)
          ? priorSource(base, sourcePath)
          : undefined;
      const expected = expectedVariantSource(
        sourcePath,
        current,
        phase,
        unfixed,
      );
      assert.equal(actual.link, undefined);
      assert.equal(actual.hash, sha256(Buffer.from(expected)));
      transformed.push({ path: logical, sha256: actual.hash });
    } else assert.deepEqual(actual, identity);
  }
  return { root: variant, reference, base, phase, transformed };
}
export function materializeFailureVariant(
  referenceDirectory: string,
  variantDirectory: string,
  baseDirectory: string,
  phase: FailurePhase,
) {
  failurePhase(phase);
  const { root: reference, base } = verifyCandidate(
    referenceDirectory,
    baseDirectory,
  );
  assert.ok(path.isAbsolute(variantDirectory));
  const variant = path.resolve(variantDirectory);
  distinctRoots(reference, variant);
  const parent = path.dirname(variant),
    canonicalParent = realpathSync(parent);
  assert.equal(parent, canonicalParent, "Variant parent must be canonical");
  mkdirSync(variant); // Fresh exclusively owned tree only; no recursive path creation.
  function copy(directory: string, output: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
        from = path.join(directory, entry.name),
        to = path.join(output, entry.name);
      if (!prefix && entry.name === "node_modules") {
        symlinkSync(realpathSync(from), to, "dir");
        continue;
      }
      if (entry.isDirectory()) {
        mkdirSync(to);
        copy(from, to, relative);
      } else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else {
        assert.ok(entry.isFile());
        copyFileSync(from, to);
      }
    }
  }
  copy(reference, variant);
  writeFileSync(path.join(variant, FAILURE_PHASE_PATH), phaseBytes(phase));
  if (phase !== "uninstrumented")
    for (const logical of sourcePaths) {
      const source = boundedFile(
        path.join(reference, logical),
        1024 * 1024,
      ).toString();
      const unfixed =
        phase === "unfixed-instrumented" &&
        (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(logical)
          ? priorSource(base, logical)
          : undefined;
      writeFileSync(
        path.join(variant, logical),
        expectedVariantSource(logical, source, phase, unfixed),
      );
    }
  return verifyFailureVariant(reference, variant, base, phase);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(process.argv.length, 6);
  materializeFailureVariant(
    process.argv[2]!,
    process.argv[3]!,
    process.argv[4]!,
    failurePhase(process.argv[5]),
  );
}
