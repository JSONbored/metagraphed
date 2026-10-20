import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boundedFile,
  validatePublicationDirectory,
  validateReceiptDirectory,
} from "./receipt-files.ts";
import {
  object,
  publicRunSummary,
  RAW_LIMITS,
  validateCompletionEvidence,
} from "./receipt-policy.ts";

import { WRANGLER_BIN_SOURCE } from "./verify-candidate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export function publish(
  rawRoot: string,
  output: string,
  candidate: string,
): void {
  if (![rawRoot, output, candidate].every((value) => path.isAbsolute(value)))
    throw new Error("Absolute publication paths required");
  if (existsSync(output))
    throw new Error("Publication directory must be fresh");
  for (const forbidden of [rawRoot, candidate]) {
    const relative = path.relative(forbidden, output);
    if (
      !relative ||
      (!relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    )
      throw new Error(
        "Publication must be outside runtime inputs and raw receipts",
      );
  }
  const expected = object(
    JSON.parse(readFileSync(path.join(here, "expected-hashes.json"), "utf8")),
  );
  for (const key of ["baseCommit", "primitiveCommit", "patchSha256"]) {
    if (
      typeof expected[key] !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expected[key])
    )
      throw new Error("Invalid identity");
  }
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    status: "setup-failed",
    baseCommit: expected.baseCommit,
    primitiveCommit: expected.primitiveCommit,
    patchSha256: expected.patchSha256,
    wranglerBinSource: WRANGLER_BIN_SOURCE,
    testsAvailable: false,
    coverageAvailable: false,
    evidenceValidated: false,
  };
  let publicLcov: string | undefined;
  if (existsSync(rawRoot)) {
    const stat = lstatSync(rawRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid raw root");
    const runs = readdirSync(rawRoot, { withFileTypes: true });
    if (
      runs.length !== 1 ||
      !runs[0]!.isDirectory() ||
      runs[0]!.isSymbolicLink() ||
      !/^native-[a-zA-Z0-9]+$/.test(runs[0]!.name)
    )
      throw new Error("Unexpected qualification runs");
    const run = path.join(rawRoot, runs[0]!.name);
    validateReceiptDirectory(run);
    const receiptPath = path.join(run, "receipt.json");
    if (existsSync(receiptPath)) {
      const rawReceipt = JSON.parse(
        boundedFile(receiptPath, RAW_LIMITS["receipt.json"]).toString(),
      );
      const receipt = publicRunSummary(rawReceipt);
      summary.status = receipt.status;
      summary.run = receipt;
      const testPath = path.join(run, "vitest-results.json");
      const coveragePath = path.join(run, "coverage/coverage-summary.json");
      const lcovPath = path.join(run, "coverage/lcov.info");
      summary.testsAvailable = existsSync(testPath);
      summary.coverageAvailable =
        existsSync(coveragePath) && existsSync(lcovPath);
      try {
        const evidence = validateCompletionEvidence(
          JSON.parse(
            boundedFile(testPath, RAW_LIMITS["vitest-results.json"]).toString(),
          ),
          JSON.parse(
            boundedFile(
              coveragePath,
              RAW_LIMITS["coverage/coverage-summary.json"],
            ).toString(),
          ),
          boundedFile(lcovPath, RAW_LIMITS["coverage/lcov.info"]).toString(),
          candidate,
        );
        summary.tests = evidence.tests;
        summary.coverage = evidence.coverage;
        summary.evidenceValidated = true;
        publicLcov = evidence.lcov;
      } catch {
        if (receipt.status === "passed")
          throw new Error("Passed receipt lacks required evidence");
        // A failed test run may have incomplete evidence. Do not publish raw errors.
      }
    }
  }
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(
    path.join(output, "qualification-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
  if (publicLcov !== undefined)
    writeFileSync(path.join(output, "candidate-coverage.lcov"), publicLcov, {
      mode: 0o600,
    });
  validatePublicationDirectory(output);
  console.log("Validated bounded qualification summary prepared.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 5)
      throw new Error("Invalid publisher arguments");
    publish(process.argv[2]!, process.argv[3]!, process.argv[4]!);
  } catch {
    // Never echo raw paths, URLs, bindings, log output, or arbitrary exception text.
    console.error("Qualification publication refused: validation failed.");
    process.exitCode = 1;
  }
}
