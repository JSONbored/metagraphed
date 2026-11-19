import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OWNER_TESTS } from "./owner-test-evidence.ts";
import { FOCUSED_TESTS } from "./verify-candidate.ts";

const root = process.env.DECODER_QUALIFICATION_ROOT;
const preload = process.env.DECODER_QUALIFICATION_PRELOAD;
const result = process.env.DECODER_QUALIFICATION_RESULT;
assert.ok(root && path.isAbsolute(root));
assert.ok(preload?.startsWith("file:"));
assert.ok(result && path.isAbsolute(result));
const globals = globalThis as unknown as Record<symbol, unknown>;
assert.ok(globals[Symbol.for("decoder-qualification.host-guard")]);
const { default: base } = (await import(
  pathToFileURL(path.join(root, "vitest.targeted.config.ts")).href
)) as {
  default: {
    test?: { coverage?: Record<string, unknown>; [key: string]: unknown };
    server?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export default {
  ...base,
  root,
  // Vite otherwise resolves the name "localhost" during client-inject startup,
  // even with HMR disabled. Keep local startup numeric; DNS remains refused.
  server: { ...base.server, host: "127.0.0.1" },
  test: {
    ...base.test,
    include: [...FOCUSED_TESTS, ...OWNER_TESTS],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    // Vitest filters ordinary coordinator --import flags out of worker argv.
    execArgv: ["--import", preload],
    globalSetup: [],
    coverage: {
      ...base.test?.coverage,
      enabled: true,
      include: ["src/strict-gzip-reader.ts", "src/sync-batch-compress.ts"],
      reporter: ["text", "json-summary", "lcovonly"],
      reportsDirectory: path.join(path.dirname(result), "coverage"),
    },
    reporters: ["default", "json"],
    outputFile: { json: result },
  },
};
