import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const pipeline = path.join(root, "scripts/pipeline.ts");
const payloadBytes = 384 * 1024;
const originalSha256 =
  "33f3afcf125f4aad4b3ebe2e84c52299b4240886679f0fe740735366628d9410";

function capturePausedPipes(command: string, env: NodeJS.ProcessEnv) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: Buffer;
    failed: boolean;
    firstReadableObserved: boolean;
    bothPausedAtFirstReadable: boolean;
    delayedConsumption: boolean;
  }>((resolve) => {
    const child = spawn(process.execPath, [command, "--check"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pause();
    child.stderr.pause();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let firstReadableObserved = false;
    let bothPausedAtFirstReadable = false;
    let delayedConsumption = false;
    let delay: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 30_000);
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        failed = true;
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
      }
    };
    const firstReadable = () => {
      if (firstReadableObserved) return;
      firstReadableObserved = true;
      bothPausedAtFirstReadable =
        child.stdout.isPaused() && child.stderr.isPaused();
      // Neither pipe is consumed until this barrier and a bounded delay pass.
      // The real pipeline must therefore handle pending asynchronous writes.
      delay = setTimeout(() => {
        delayedConsumption = true;
        child.stdout.removeListener("readable", firstReadable);
        child.stderr.removeListener("readable", firstReadable);
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.stdout.resume();
        child.stderr.resume();
      }, 50);
    };
    child.stdout.on("readable", firstReadable);
    child.stderr.on("readable", firstReadable);
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (status, signal) => {
      clearTimeout(deadline);
      if (delay !== undefined) clearTimeout(delay);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        failed,
        firstReadableObserved,
        bothPausedAtFirstReadable,
        delayedConsumption,
      });
    });
  });
}

async function runFixture(failAt?: string, original = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "pipeline-emission-"));
  const bin = path.join(directory, "bin");
  const callsFile = path.join(directory, "calls.ndjson");
  try {
    mkdirSync(bin);
    writeFileSync(path.join(bin, "package.json"), '{"type":"commonjs"}\n');
    // Only this child receives synthetic npm children. The harness does not
    // execute project command gates or claim native project-command acceptance.
    writeFileSync(
      path.join(bin, "npm"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const [verb, script, ...extra] = process.argv.slice(2);
if (process.execPath !== process.env.PIPELINE_FIXTURE_NODE || verb !== "run" || !script || extra.length) {
  process.exitCode = 91;
} else {
  appendFileSync(process.env.PIPELINE_FIXTURE_CALLS, JSON.stringify({verb, script}) + "\\n");
  if (script === process.env.PIPELINE_FIXTURE_FAIL_AT) {
    process.stdout.write("A".repeat(${payloadBytes}));
    process.stderr.write("B".repeat(${payloadBytes}));
    process.exitCode = 7;
  }
}
`,
      { mode: 0o755 },
    );
    let entrypoint = pipeline;
    if (original) {
      const bytes = readFileSync(
        path.join(root, "tests/fixtures/pipeline-emission-original.ts.payload"),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        originalSha256,
      );
      entrypoint = path.join(directory, "pipeline-original.ts");
      writeFileSync(entrypoint, bytes);
      writeFileSync(
        path.join(directory, "package.json"),
        '{"type":"module"}\n',
      );
      // The original source and its import spelling remain byte-for-byte exact.
      symlinkSync(
        path.join(root, "scripts/lib.ts"),
        path.join(directory, "lib.ts"),
      );
    }
    const result = await capturePausedPipes(entrypoint, {
      ...process.env,
      PATH: bin + path.delimiter + (process.env.PATH ?? ""),
      PIPELINE_FIXTURE_NODE: process.execPath,
      PIPELINE_FIXTURE_CALLS: callsFile,
      PIPELINE_FIXTURE_FAIL_AT: failAt ?? "",
    });
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { verb: string; script: string })
      : [];
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")(
  "pipeline POSIX pipe emission",
  () => {
    for (const prefix of [
      ["artifacts:prepare-local"],
      ["artifacts:prepare-local", "sync:subnets:dry-run"],
    ]) {
      it(`drains both streams and retains failure at ordinal ${prefix.length}`, async () => {
        const result = await runFixture(prefix.at(-1));
        expect(result.failed).toBe(false);
        expect(result.firstReadableObserved).toBe(true);
        expect(result.bothPausedAtFirstReadable).toBe(true);
        expect(result.delayedConsumption).toBe(true);
        expect(result.status).toBe(7);
        expect(result.signal).toBeNull();
        expect(result.calls).toEqual(
          prefix.map((script) => ({ verb: "run", script })),
        );
        expect(result.stdout.byteLength).toBe(payloadBytes);
        expect(result.stdout.every((byte) => byte === 65)).toBe(true);
        expect(result.stderr.byteLength).toBeGreaterThan(payloadBytes);
        expect(
          result.stderr.subarray(0, payloadBytes).every((byte) => byte === 66),
        ).toBe(true);
        const terminal = result.stderr
          .subarray(payloadBytes)
          .toString("utf8")
          .trim();
        expect(Buffer.byteLength(terminal)).toBeLessThanOrEqual(16 * 1024);
        const report = JSON.parse(terminal) as {
          failed_script: string;
          mode: string;
          results: { script: string; status: string; elapsed_ms: number }[];
        };
        expect(Object.keys(report).sort()).toEqual([
          "failed_script",
          "mode",
          "results",
        ]);
        expect(report.mode).toBe("check");
        expect(report.failed_script).toBe(prefix.at(-1));
        expect(report.results.map((row) => row.script)).toEqual(prefix);
        expect(report.results.map((row) => row.status)).toEqual(
          prefix.map((_, index) =>
            index === prefix.length - 1 ? "failed" : "passed",
          ),
        );
        expect(
          report.results.every(
            (row) =>
              Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= 0,
          ),
        ).toBe(true);
      }, 40_000);
    }

    it("detects terminal loss from the exact pinned immediate-exit original", async () => {
      const result = await runFixture("artifacts:prepare-local", true);
      expect(result.failed).toBe(false);
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.firstReadableObserved).toBe(true);
      expect(result.bothPausedAtFirstReadable).toBe(true);
      expect(result.delayedConsumption).toBe(true);
      expect(result.calls).toEqual([
        { verb: "run", script: "artifacts:prepare-local" },
      ]);
      // Both streams receive exactly the same bounded pressure as the repair.
      // A complete terminal report would be after all B bytes. Assert its absence
      // without serializing synthetic output into an assertion failure message.
      expect(result.stderr.byteLength <= payloadBytes).toBe(true);
      expect(result.stderr.every((byte) => byte === 66)).toBe(true);
      expect(result.stdout.byteLength <= payloadBytes).toBe(true);
      expect(result.stdout.every((byte) => byte === 65)).toBe(true);
    }, 40_000);

    it("keeps the full 85-command success path and summary", async () => {
      const result = await runFixture();
      expect(result.failed).toBe(false);
      expect(result.firstReadableObserved).toBe(true);
      expect(result.bothPausedAtFirstReadable).toBe(true);
      expect(result.delayedConsumption).toBe(true);
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr.byteLength).toBe(0);
      expect(result.calls).toHaveLength(85);
      expect(result.calls[0]).toEqual({
        verb: "run",
        script: "artifacts:prepare-local",
      });
      expect(result.calls.at(-1)).toEqual({ verb: "run", script: "test" });
      expect(new Set(result.calls.map((row) => row.script)).size).toBe(85);
      const report = JSON.parse(result.stdout.toString("utf8")) as {
        mode: string;
        result_count: number;
        results: { script: string; status: string }[];
      };
      expect(report.mode).toBe("check");
      expect(report.result_count).toBe(85);
      expect(report.results.map((row) => row.script)).toEqual(
        result.calls.map((row) => row.script),
      );
      expect(report.results.every((row) => row.status === "passed")).toBe(true);
    }, 40_000);
  },
);
