// A recovery script's documented command must resolve the version it was
// written against (#10331).
//
// `scripts/pyproject.toml` pins `bittensor==10.5.0`, and every chain-direct
// script's docstring told you to run it with a BARE `--with bittensor`, which
// consults nothing and resolves latest. Latest is 11.x, where `bt.SubtensorApi`
// no longer exists, so the documented command for all four failed at the first
// line that touches the SDK:
//
//     AttributeError: module 'bittensor' has no attribute 'SubtensorApi'
//
// These are the RECOVERY tools -- each one exists to reconstruct data the live
// lanes missed, so each is run rarely, by someone under time pressure, at the
// moment a gap has been found. Nothing exercises them between incidents, which
// is why the breakage sat there invisibly and why a static check is worth
// having: it costs one read of four files and it fires on the commit rather
// than during the next incident.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");

/** Every `uv run …` line in the scripts' own docstrings. */
function runLines(): { file: string; line: string }[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".py"))
    .flatMap((file) =>
      fs
        .readFileSync(path.join(SCRIPTS_DIR, file), "utf8")
        .split("\n")
        .filter((line) => line.includes("uv run"))
        .map((line) => ({ file, line: line.trim() })),
    );
}

describe("the documented run command", () => {
  test("exists -- these lines are the only install instructions there are", () => {
    // If this ever reads zero the checks below pass vacuously, which is the
    // one way a gate like this fails silently.
    assert.ok(runLines().length >= 4, `found ${runLines().length} run lines`);
  });

  test("never installs bittensor UNPINNED", () => {
    // `--with bittensor` overrides nothing and consults nothing.
    for (const { file, line } of runLines()) {
      assert.ok(
        !/--with\s+bittensor(?![=<>])/.test(line),
        `${file}: '--with bittensor' resolves latest, not the pinned 10.5.0 -- ` +
          `use '--project scripts' so pyproject.toml is consulted:\n  ${line}`,
      );
    }
  });

  test("reaches the pin through --project, not a second copy of the version", () => {
    // Restating `==10.5.0` in five docstrings would work today and drift on the
    // next bump; `--project scripts` has one place to change.
    for (const { file, line } of runLines()) {
      if (!/scripts\/\S+\.py/.test(line)) continue;
      assert.match(
        line,
        /--project\s+scripts/,
        `${file}: run line does not use --project scripts:\n  ${line}`,
      );
    }
  });
});

describe("the pin itself", () => {
  test("is declared, and is the version the scripts' API expects", () => {
    // bt.SubtensorApi is what all five callers use, and it exists in 10.x and
    // not in 11.x. Asserting the exact pin means a bump has to come with a
    // decision about that API rather than as a silent dependency drift.
    const toml = fs.readFileSync(
      path.join(SCRIPTS_DIR, "pyproject.toml"),
      "utf8",
    );
    assert.match(toml, /bittensor==10\.5\.0/);
  });
});
