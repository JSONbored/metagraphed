import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import codegenConfig from "../codegen.ts";

interface ShellQuote {
  parse(command: string): unknown[];
  quote(args: string[]): string;
}

type LaunchEditor = (file: string, editor: string) => void;

const rootRequire = createRequire(import.meta.url);
const codegenRequire = createRequire(rootRequire.resolve("@graphql-codegen/cli"));
const editorRequire = createRequire(rootRequire.resolve("launch-editor"));
const shellQuote = rootRequire("shell-quote") as ShellQuote;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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
  // Codegen imports exec by name. Publish the same stubs to native ESM before
  // importing its public entry, including when an external module is cached.
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both consumers resolve the shared reader and retain ordinary argument round trips", () => {
  const sharedPath = rootRequire.resolve("shell-quote");
  expect(codegenRequire.resolve("shell-quote")).toBe(sharedPath);
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

test("the repository's local SDL generates without configured shell hooks", async () => {
  expect(codegenConfig.schema).toBe("generated/graphql/schema.ts");
  expect(Object.hasOwn(codegenConfig, "hooks")).toBe(false);
  const configuredOutput = codegenConfig.generates["generated/graphql/types.ts"];
  if (
    typeof configuredOutput !== "object" ||
    configuredOutput === null ||
    Array.isArray(configuredOutput)
  ) {
    throw new Error("Expected the configured TypeScript output");
  }
  expect(Object.hasOwn(configuredOutput, "hooks")).toBe(false);

  const output = path.join(temporaryRoot(), "output types.ts");
  const { generate } = await import("@graphql-codegen/cli");
  const generated = (await generate(
    {
      ...codegenConfig,
      cwd: repoRoot,
      silent: true,
      generates: { [output]: configuredOutput },
    },
    false,
  )) as { filename: string; content: string }[];

  expect(generated.map((file) => file.filename)).toEqual([output]);
  expect(generated[0].content).toContain("export type Query");
  expect(childProcess.exec).not.toHaveBeenCalled();
});

test("Codegen quotes an ordinary output path before passing a string hook to exec", async () => {
  const root = temporaryRoot();
  const schema = path.join(root, "local schema.graphql");
  const output = path.join(root, "output types.ts");
  writeFileSync(schema, "type Query { greeting: String! }\n");
  const child = new EventEmitter() as childProcess.ChildProcess;
  vi.mocked(childProcess.exec).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback === "function") callback(null, "", "");
    return child;
  });
  syncBuiltinESMExports();

  const { generate } = await import("@graphql-codegen/cli");
  await generate({
    cwd: repoRoot,
    schema,
    silent: true,
    generates: { [output]: { plugins: ["typescript"] } },
    hooks: { beforeOneFileWrite: ["consumer-compatibility-fixture"] },
  });

  expect(childProcess.exec).toHaveBeenCalledTimes(1);
  const command = vi.mocked(childProcess.exec).mock.calls[0][0];
  expect(shellQuote.parse(command)).toEqual([
    "consumer-compatibility-fixture",
    output,
  ]);
  expect(readFileSync(output, "utf8")).toContain(
    "greeting: Scalars['String']['output']",
  );
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
