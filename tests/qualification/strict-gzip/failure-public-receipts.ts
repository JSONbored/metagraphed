import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
import { publicFailureNativeDiagnostics } from "./failure-native-diagnostics.ts";
import {
  failureReplayDiagnostic,
  projectFailureReplayDiagnostics,
  type FailureReplayDiagnostic,
  type FailureReplayStage,
} from "./failure-replay-diagnostics.ts";
import { validateFailureTestEvidence } from "./failure-test-evidence.ts";
import { threadLifecycleEvidence } from "./receipt-policy.ts";
// Combines the unchanged baseline publisher with three independently validated
// failure phases. Only the same two bounded sanitized artifact names are public.
import assert from "node:assert/strict";
import { assertFailureCompletion } from "./failure-completion.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { publish as publishBaseline } from "./owner-public-receipts.ts";
import { boundedFile, validatePublicationDirectory } from "./receipt-files.ts";
import {
  PUBLIC_LIMITS,
  RAW_LIMITS,
  publicRunSummary,
} from "./receipt-policy.ts";
import { FAILURE_PHASES, verifyFailureVariant } from "./failure-variants.ts";
import {
  validateFailurePhaseEvidence,
  validateFailureReceiptDirectory,
} from "./failure-evidence.ts";
import { verifyCandidate } from "./verify-candidate.ts";
function onlyRun(root: string) {
  try {
    const stat = withFailureReplayReason("fpu-io-001", () => lstatSync(root));
    try {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-001");
    }
    const entries = withFailureReplayReason("fpu-io-002", () =>
      readdirSync(root, { withFileTypes: true }),
    );
    try {
      assert.equal(entries.length, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-002");
    }
    const entry = entries[0]!;
    try {
      assert.ok(
        entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^native-[a-zA-Z0-9]+$/.test(entry.name),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-003");
    }
    return path.join(root, entry.name);
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpu-stage-001");
  }
}
async function replayFailureDiagnostics(
  run: string,
  variant: string,
  reference: string,
  base: string,
  phase: (typeof FAILURE_PHASES)[number],
) {
  const diagnostics: FailureReplayDiagnostic[] = [];
  const observe = async (stage: FailureReplayStage, action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      diagnostics.push(failureReplayDiagnostic(error, stage)!);
    }
  };
  await observe("thread-lifecycle", () =>
    threadLifecycleEvidence(
      boundedFile(
        path.join(run, "network-events.ndjson"),
        RAW_LIMITS["network-events.ndjson"],
      )
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ),
  );
  await observe("variant", () =>
    verifyFailureVariant(reference, variant, base, phase, true),
  );
  await observe("test-evidence", () =>
    validateFailureTestEvidence(
      JSON.parse(
        boundedFile(
          path.join(run, "vitest-results.json"),
          RAW_LIMITS["vitest-results.json"],
        ).toString(),
      ),
      variant,
      phase,
    ),
  );
  await observe("owner-evidence", () =>
    validateFailurePhaseEvidence(run, variant, phase),
  );
  return diagnostics;
}
// Failure-only diagnostics never participate in phase acceptance.
function readFailureNativeTestDiagnostics(
  run: string,
  root: string,
  phase: string,
  status: unknown,
) {
  try {
    return publicFailureNativeDiagnostics(
      JSON.parse(
        boundedFile(
          path.join(run, "vitest-results.json"),
          RAW_LIMITS["vitest-results.json"],
        ).toString(),
      ),
      root,
      phase,
      status,
    );
  } catch {
    return [];
  }
}
export async function publishFailureQualification(
  raw: string,
  output: string,
  reference: string,
  base: string,
  variantsRoot: string,
) {
  try {
    for (const value of [raw, output, reference, base, variantsRoot])
      try {
        assert.ok(path.isAbsolute(value));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpu-check-004");
      }
    try {
      assert.equal(
        withFailureReplayReason("fpu-io-003", () => existsSync(output)),
        false,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-005");
    }
    for (const input of [raw, reference, base, variantsRoot])
      try {
        assert.ok(
          path.resolve(output) !== path.resolve(input) &&
            !path.resolve(output).startsWith(path.resolve(input) + path.sep),
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpu-check-006");
      }
    const summary: Record<string, unknown> = {
      schemaVersion: 2,
      status: "setup-failed",
      evidenceValidated: false,
      failureQualificationValidated: false,
      productionMemory: "inconclusive",
      productionCpu: "inconclusive",
    };
    let lcov: string | undefined;
    const privateParent = mkdtempSync(
      path.join(tmpdir(), "failure-publication-"),
    );
    try {
      if (withFailureReplayReason("fpu-io-004", () => existsSync(raw))) {
        const stat = withFailureReplayReason("fpu-io-005", () =>
          lstatSync(raw),
        );
        try {
          assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpu-check-007");
        }
        for (const entry of withFailureReplayReason("fpu-io-006", () =>
          readdirSync(raw, { withFileTypes: true }),
        )) {
          try {
            assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpu-check-008");
          }
          try {
            assert.ok(
              ["baseline", ...FAILURE_PHASES].includes(entry.name as never),
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpu-check-009");
          }
        }
      }
      const baselineOutput = path.join(privateParent, "baseline");
      await publishBaseline(
        path.join(raw, "baseline"),
        baselineOutput,
        reference,
      );
      const baseline = withFailureReplayReason("fpu-io-007", () =>
        JSON.parse(
          withFailureReplayReason("fpu-io-008", () =>
            boundedFile(
              path.join(baselineOutput, "qualification-summary.json"),
              PUBLIC_LIMITS["qualification-summary.json"],
            ),
          ).toString(),
        ),
      );
      summary.baseline = baseline;
      summary.status = "failed";
      if (
        withFailureReplayReason("fpu-io-009", () =>
          existsSync(path.join(baselineOutput, "candidate-coverage.lcov")),
        )
      )
        lcov = withFailureReplayReason("fpu-io-010", () =>
          boundedFile(
            path.join(baselineOutput, "candidate-coverage.lcov"),
            PUBLIC_LIMITS["candidate-coverage.lcov"],
          ),
        ).toString();
      const phases: Record<string, unknown>[] = [];
      let complete =
        baseline.status === "passed" && baseline.evidenceValidated === true;
      withFailureReplayReason("fpu-io-011", () =>
        verifyCandidate(reference, base, true),
      );
      for (const phase of FAILURE_PHASES) {
        const state: Record<string, unknown> = {
          phase,
          status: "missing",
          evidenceValidated: false,
        };
        phases.push(state);
        if (
          !withFailureReplayReason("fpu-io-012", () =>
            existsSync(path.join(raw, phase)),
          )
        ) {
          complete = false;
          continue;
        }
        const run = onlyRun(path.join(raw, phase));
        validateFailureReceiptDirectory(run);
        if (
          !withFailureReplayReason("fpu-io-013", () =>
            existsSync(path.join(run, "receipt.json")),
          )
        ) {
          complete = false;
          continue;
        }
        const rawReceipt = withFailureReplayReason("fpu-io-014", () =>
          JSON.parse(
            withFailureReplayReason("fpu-io-015", () =>
              boundedFile(
                path.join(run, "receipt.json"),
                RAW_LIMITS["receipt.json"],
              ),
            ).toString(),
          ),
        );
        const receipt = publicRunSummary(rawReceipt, 1);
        state.run = receipt;
        state.status = receipt.status;
        let nativeDiagnosticSourceVerified = false;
        try {
          const variant = path.join(variantsRoot, phase);
          verifyFailureVariant(reference, variant, base, phase, true);
          nativeDiagnosticSourceVerified = true;
          state.proof = await validateFailurePhaseEvidence(run, variant, phase);
          state.evidenceValidated = true;
        } catch {
          if (receipt.status === "passed")
            throw new Error("Passed phase lacks required proof");
          complete = false;
        }
        if (receipt.status === "failed")
          state.failureReplayDiagnostics = projectFailureReplayDiagnostics(
            rawReceipt.failureReplayDiagnostics,
            await replayFailureDiagnostics(
              run,
              path.join(variantsRoot, phase),
              reference,
              base,
              phase,
            ),
            receipt.status,
          );
        if (receipt.status === "failed" && nativeDiagnosticSourceVerified)
          state.failureNativeDiagnostics = readFailureNativeTestDiagnostics(
            run,
            path.join(variantsRoot, phase),
            phase,
            receipt.status,
          );
        if (receipt.status !== "passed" || state.evidenceValidated !== true)
          complete = false;
      }
      if (complete)
        summary.assertions = assertFailureCompletion(baseline, phases);
      summary.phases = phases;
      summary.evidenceValidated = complete;
      summary.failureQualificationValidated = complete;
      summary.status = complete ? "passed" : "failed";
    } finally {
      rmSync(privateParent, { recursive: true, force: true });
    }
    mkdirSync(output, { mode: 0o700 });
    const bytes = JSON.stringify(summary, null, 2) + "\n";
    try {
      assert.ok(
        Buffer.byteLength(bytes) <= PUBLIC_LIMITS["qualification-summary.json"],
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-010");
    }
    writeFileSync(path.join(output, "qualification-summary.json"), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    if (lcov !== undefined)
      writeFileSync(path.join(output, "candidate-coverage.lcov"), lcov, {
        flag: "wx",
        mode: 0o600,
      });
    validatePublicationDirectory(output);
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpu-stage-002");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    try {
      assert.equal(process.argv.length, 7);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpu-check-011");
    }
    await publishFailureQualification(
      process.argv[2]!,
      process.argv[3]!,
      process.argv[4]!,
      process.argv[5]!,
      process.argv[6]!,
    );
  } catch (error) {
    console.error(
      JSON.stringify(failureReplayDiagnostic(error, "publication")),
    );
    console.error(
      "Failure qualification publication refused: validation failed.",
    );
    process.exitCode = 1;
  }
}
