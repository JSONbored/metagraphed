import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
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
  try {
    try {
      assert.ok(FAILURE_PHASES.includes(value as FailurePhase));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-001");
    }
    return value as FailurePhase;
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-001");
  }
}
export function phaseBytes(phase: FailurePhase): Buffer {
  try {
    failurePhase(phase);
    return Buffer.from(JSON.stringify({ phase }) + "\n");
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-002");
  }
}
function priorSource(
  base: string,
  logical: FailureLifecycleSourcePath,
): string {
  try {
    try {
      assert.ok(sourcePaths.includes(logical));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-002");
    }
    const bytes = withFailureReplayReason("fva-io-001", () =>
      execFileSync("git", ["-C", base, "show", `${originalBase}:${logical}`], {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        maxBuffer: 1024 * 1024,
      }),
    );
    try {
      assert.equal(
        sha256(bytes),
        FAILURE_LIFECYCLE_SOURCE_PINS[logical].unfixed,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-003");
    }
    return bytes.toString();
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-003");
  }
}
export function expectedVariantSource(
  logical: FailureLifecycleSourcePath,
  current: string,
  phase: FailurePhase,
  unfixed?: string,
) {
  try {
    failurePhase(phase);
    try {
      assert.ok(sourcePaths.includes(logical));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-004");
    }
    try {
      assert.equal(
        sha256(Buffer.from(current)),
        FAILURE_LIFECYCLE_SOURCE_PINS[logical].fixed,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-005");
    }
    if (phase === "uninstrumented") return current;
    const variant = phase === "unfixed-instrumented" ? "unfixed" : "fixed";
    const before =
      variant === "unfixed" &&
      (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(logical)
        ? unfixed
        : current;
    try {
      assert.equal(typeof before, "string");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-006");
    }
    return withFailureReplayReason("fva-io-002", () =>
      instrumentFailureLifecycleSource(logical, before!, variant),
    ).source;
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-004");
  }
}
function distinctRoots(reference: string, variant: string) {
  try {
    try {
      assert.ok(path.isAbsolute(reference) && path.isAbsolute(variant));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-007");
    }
    try {
      assert.notEqual(reference, variant);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-008");
    }
    try {
      assert.ok(
        !reference.startsWith(variant + path.sep) &&
          !variant.startsWith(reference + path.sep),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-009");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-005");
  }
}
function inventory(root: string, afterRun: boolean) {
  try {
    const result = new Map<
      string,
      { mode: number; link?: string; hash?: string }
    >();
    const ignored = new Set([
      "node_modules",
      ...(afterRun ? [".wrangler", ".mf", ".miniflare"] : []),
    ]);
    function walk(directory: string, prefix = "") {
      try {
        for (const entry of withFailureReplayReason("fva-io-003", () =>
          readdirSync(directory, { withFileTypes: true }),
        )) {
          if (!prefix && ignored.has(entry.name)) continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
            file = path.join(directory, entry.name),
            stat = withFailureReplayReason("fva-io-004", () => lstatSync(file));
          if (entry.isDirectory()) {
            try {
              assert.ok(!stat.isSymbolicLink());
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fva-check-010");
            }
            walk(file, relative);
          } else if (stat.isSymbolicLink())
            result.set(relative, {
              mode: stat.mode & 0o111,
              link: withFailureReplayReason("fva-io-005", () =>
                readlinkSync(file),
              ),
            });
          else {
            try {
              assert.ok(stat.isFile());
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fva-check-011");
            }
            result.set(relative, {
              mode: stat.mode & 0o111,
              hash: sha256(
                withFailureReplayReason("fva-io-006", () => readFileSync(file)),
              ),
            });
          }
        }
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fva-stage-007");
      }
    }
    walk(root);
    return result;
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-006");
  }
}
export function verifyFailureVariant(
  referenceDirectory: string,
  variantDirectory: string,
  baseDirectory: string,
  phase: FailurePhase,
  afterRun = false,
) {
  try {
    failurePhase(phase);
    const { root: reference, base } = withFailureReplayReason(
      "fva-io-007",
      () => verifyCandidate(referenceDirectory, baseDirectory, afterRun),
    );
    try {
      assert.ok(path.isAbsolute(variantDirectory));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-012");
    }
    const variantStat = withFailureReplayReason("fva-io-008", () =>
      lstatSync(variantDirectory),
    );
    try {
      assert.ok(variantStat.isDirectory() && !variantStat.isSymbolicLink());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-013");
    }
    const variant = withFailureReplayReason("fva-io-009", () =>
      realpathSync(variantDirectory),
    );
    try {
      assert.equal(variant, variantDirectory);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-014");
    }
    distinctRoots(reference, variant);
    try {
      assert.equal(
        withFailureReplayReason("fva-io-010", () =>
          realpathSync(path.join(variant, "node_modules")),
        ),
        withFailureReplayReason("fva-io-011", () =>
          realpathSync(path.join(reference, "node_modules")),
        ),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-015");
    }
    const before = inventory(reference, afterRun),
      after = inventory(variant, afterRun);
    try {
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-016");
    }
    const transformed = [];
    for (const [logical, identity] of before) {
      const actual = after.get(logical)!;
      try {
        assert.equal(actual.mode, identity.mode);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fva-check-017");
      }
      if (logical === FAILURE_PHASE_PATH) {
        try {
          assert.equal(actual.link, undefined);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fva-check-018");
        }
        try {
          assert.equal(actual.hash, sha256(phaseBytes(phase)));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fva-check-019");
        }
        continue;
      }
      if (sourcePaths.includes(logical as FailureLifecycleSourcePath)) {
        const sourcePath = logical as FailureLifecycleSourcePath;
        const current = withFailureReplayReason("fva-io-012", () =>
          boundedFile(path.join(reference, logical), 1024 * 1024),
        ).toString();
        const unfixed =
          phase === "unfixed-instrumented" &&
          (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(
            logical,
          )
            ? priorSource(base, sourcePath)
            : undefined;
        const expected = expectedVariantSource(
          sourcePath,
          current,
          phase,
          unfixed,
        );
        try {
          assert.equal(actual.link, undefined);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fva-check-020");
        }
        try {
          assert.equal(actual.hash, sha256(Buffer.from(expected)));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fva-check-021");
        }
        transformed.push({ path: logical, sha256: actual.hash });
      } else
        try {
          assert.deepEqual(actual, identity);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fva-check-022");
        }
    }
    return { root: variant, reference, base, phase, transformed };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-008");
  }
}
export function materializeFailureVariant(
  referenceDirectory: string,
  variantDirectory: string,
  baseDirectory: string,
  phase: FailurePhase,
) {
  try {
    failurePhase(phase);
    const { root: reference, base } = withFailureReplayReason(
      "fva-io-013",
      () => verifyCandidate(referenceDirectory, baseDirectory),
    );
    try {
      assert.ok(path.isAbsolute(variantDirectory));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-023");
    }
    const variant = path.resolve(variantDirectory);
    distinctRoots(reference, variant);
    const parent = path.dirname(variant),
      canonicalParent = withFailureReplayReason("fva-io-014", () =>
        realpathSync(parent),
      );
    try {
      assert.equal(parent, canonicalParent, "Variant parent must be canonical");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fva-check-024");
    }
    mkdirSync(variant); // Fresh exclusively owned tree only; no recursive path creation.
    function copy(directory: string, output: string, prefix = "") {
      try {
        for (const entry of withFailureReplayReason("fva-io-015", () =>
          readdirSync(directory, { withFileTypes: true }),
        )) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
            from = path.join(directory, entry.name),
            to = path.join(output, entry.name);
          if (!prefix && entry.name === "node_modules") {
            symlinkSync(
              withFailureReplayReason("fva-io-016", () => realpathSync(from)),
              to,
              "dir",
            );
            continue;
          }
          if (entry.isDirectory()) {
            mkdirSync(to);
            copy(from, to, relative);
          } else if (entry.isSymbolicLink())
            symlinkSync(
              withFailureReplayReason("fva-io-017", () => readlinkSync(from)),
              to,
            );
          else {
            try {
              assert.ok(entry.isFile());
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fva-check-025");
            }
            copyFileSync(from, to);
          }
        }
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fva-stage-010");
      }
    }
    copy(reference, variant);
    writeFileSync(path.join(variant, FAILURE_PHASE_PATH), phaseBytes(phase));
    if (phase !== "uninstrumented")
      for (const logical of sourcePaths) {
        const source = withFailureReplayReason("fva-io-018", () =>
          boundedFile(path.join(reference, logical), 1024 * 1024),
        ).toString();
        const unfixed =
          phase === "unfixed-instrumented" &&
          (FAILURE_LIFECYCLE_UNFIXED_PATHS as readonly string[]).includes(
            logical,
          )
            ? priorSource(base, logical)
            : undefined;
        writeFileSync(
          path.join(variant, logical),
          expectedVariantSource(logical, source, phase, unfixed),
        );
      }
    return verifyFailureVariant(reference, variant, base, phase);
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-stage-009");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    assert.equal(process.argv.length, 6);
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fva-check-026");
  }
  materializeFailureVariant(
    process.argv[2]!,
    process.argv[3]!,
    process.argv[4]!,
    failurePhase(process.argv[5]),
  );
}
