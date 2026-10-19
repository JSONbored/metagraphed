import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

interface ShellQuote {
  parse(command: string): unknown[];
  quote(args: string[]): string;
}

type LaunchEditor = (file: string, editor: string) => void;

const rootRequire = createRequire(import.meta.url);
const editorRequire = createRequire(rootRequire.resolve("launch-editor"));
const shellQuote = rootRequire("shell-quote") as ShellQuote;
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "shell-quote consumers "));
  temporaryRoots.push(root);
  return root;
}

beforeEach(() => {
  vi.resetModules();
  // Mutate the shared builtin object: a vi.mock alone would not intercept
  // launch-editor's CommonJS require. Unexpected process launches fail closed.
  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ] as const) {
    vi.spyOn(childProcess, method).mockImplementation(() => {
      throw new Error(`Unexpected child-process call: ${method}`);
    });
  }
  // Publish the same stubs to native ESM before importing a consumer,
  // including when an external module is cached.
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch-editor resolves the shared reader and retains ordinary argument round trips", () => {
  const sharedPath = rootRequire.resolve("shell-quote");
  expect(editorRequire.resolve("shell-quote")).toBe(sharedPath);

  const args = [
    "--check",
    "generated/output types.ts",
    "author's notes.ts",
    "docs\\draft.ts",
    "",
  ];
  expect(shellQuote.parse(shellQuote.quote(args))).toEqual(args);
});

test.each([
  '"Editor Suite" --reuse-window --profile "Work notes"',
  "Editor\\ Suite --reuse-window --profile Work\\ notes",
])("launch-editor parses an explicit ordinary editor setting: %s", (editor) => {
  const file = path.join(temporaryRoot(), "ordinary notes.ts");
  writeFileSync(file, "export {};\n");
  const child = new EventEmitter() as childProcess.ChildProcess;
  vi.mocked(childProcess.spawn).mockReturnValue(child);
  vi.mocked(childProcess.exec).mockReturnValue(child);
  syncBuiltinESMExports();

  const launchEditor = editorRequire("launch-editor") as LaunchEditor;
  try {
    launchEditor(file, editor);

    if (process.platform === "win32") {
      expect(childProcess.exec).toHaveBeenCalledTimes(1);
      expect(vi.mocked(childProcess.exec).mock.calls[0][0]).toBe(
        `"Editor Suite" --reuse-window --profile "Work notes" "${file}"`,
      );
    } else {
      expect(childProcess.spawn).toHaveBeenCalledExactlyOnceWith(
        "Editor Suite",
        ["--reuse-window", "--profile", "Work notes", file],
        { stdio: "inherit" },
      );
    }
  } finally {
    // Clear the launcher's active-child state before restoring the stubs.
    child.emit("exit", 0);
  }
});
