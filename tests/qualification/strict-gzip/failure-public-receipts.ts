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
  const stat = lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const entries = readdirSync(root, { withFileTypes: true });
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.ok(
    entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      /^native-[a-zA-Z0-9]+$/.test(entry.name),
  );
  return path.join(root, entry.name);
}
export async function publishFailureQualification(
  raw: string,
  output: string,
  reference: string,
  base: string,
  variantsRoot: string,
) {
  for (const value of [raw, output, reference, base, variantsRoot])
    assert.ok(path.isAbsolute(value));
  assert.equal(existsSync(output), false);
  for (const input of [raw, reference, base, variantsRoot])
    assert.ok(
      path.resolve(output) !== path.resolve(input) &&
        !path.resolve(output).startsWith(path.resolve(input) + path.sep),
    );
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
    if (existsSync(raw)) {
      const stat = lstatSync(raw);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      for (const entry of readdirSync(raw, { withFileTypes: true })) {
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        assert.ok(
          ["baseline", ...FAILURE_PHASES].includes(entry.name as never),
        );
      }
    }
    const baselineOutput = path.join(privateParent, "baseline");
    await publishBaseline(
      path.join(raw, "baseline"),
      baselineOutput,
      reference,
    );
    const baseline = JSON.parse(
      boundedFile(
        path.join(baselineOutput, "qualification-summary.json"),
        PUBLIC_LIMITS["qualification-summary.json"],
      ).toString(),
    );
    summary.baseline = baseline;
    summary.status = "failed";
    if (existsSync(path.join(baselineOutput, "candidate-coverage.lcov")))
      lcov = boundedFile(
        path.join(baselineOutput, "candidate-coverage.lcov"),
        PUBLIC_LIMITS["candidate-coverage.lcov"],
      ).toString();
    const phases: Record<string, unknown>[] = [];
    let complete =
      baseline.status === "passed" && baseline.evidenceValidated === true;
    verifyCandidate(reference, base, true);
    for (const phase of FAILURE_PHASES) {
      const state: Record<string, unknown> = {
        phase,
        status: "missing",
        evidenceValidated: false,
      };
      phases.push(state);
      if (!existsSync(path.join(raw, phase))) {
        complete = false;
        continue;
      }
      const run = onlyRun(path.join(raw, phase));
      validateFailureReceiptDirectory(run);
      if (!existsSync(path.join(run, "receipt.json"))) {
        complete = false;
        continue;
      }
      const receipt = publicRunSummary(
        JSON.parse(
          boundedFile(
            path.join(run, "receipt.json"),
            RAW_LIMITS["receipt.json"],
          ).toString(),
        ),
        1,
      );
      state.run = receipt;
      state.status = receipt.status;
      try {
        const variant = path.join(variantsRoot, phase);
        verifyFailureVariant(reference, variant, base, phase, true);
        state.proof = await validateFailurePhaseEvidence(run, variant, phase);
        state.evidenceValidated = true;
      } catch {
        if (receipt.status === "passed")
          throw new Error("Passed phase lacks required proof");
        complete = false;
      }
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
  assert.ok(
    Buffer.byteLength(bytes) <= PUBLIC_LIMITS["qualification-summary.json"],
  );
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
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    assert.equal(process.argv.length, 7);
    await publishFailureQualification(
      process.argv[2]!,
      process.argv[3]!,
      process.argv[4]!,
      process.argv[5]!,
      process.argv[6]!,
    );
  } catch {
    console.error(
      "Failure qualification publication refused: validation failed.",
    );
    process.exitCode = 1;
  }
}
