import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { flagValue } from "../scripts/lib.ts";

// #6365: scripts/ grew two flag conventions independently. r2-download.ts read
// `--prefix=` only, while endpoint-ops-brief.ts -- which has its own
// space-separated `valueAfter` parser -- printed `npm run r2:download --
// --prefix latest/` as its remediation command. Following that printed command
// dropped the flag silently: no token started with "--prefix=", so prefixArg was
// undefined and the download fell back to manifest.latest_prefix with no error
// and no warning. flagValue accepts both forms so neither convention can
// silently lose a flag again.
describe("flagValue accepts both CLI flag conventions (#6365)", () => {
  test("reads the equals form", () => {
    assert.equal(flagValue(["--prefix=latest/"], "--prefix"), "latest/");
  });

  test("reads the space-separated form (the one that used to be dropped)", () => {
    assert.equal(flagValue(["--prefix", "latest/"], "--prefix"), "latest/");
  });

  test("both forms agree, whatever the surrounding argv", () => {
    const equals = ["--write", "--prefix=2026-07-17/", "--out=tmp/x"];
    const spaced = ["--write", "--prefix", "2026-07-17/", "--out", "tmp/x"];
    assert.equal(
      flagValue(equals, "--prefix"),
      flagValue(spaced, "--prefix"),
      "the two conventions must resolve identically",
    );
    assert.equal(flagValue(equals, "--out"), flagValue(spaced, "--out"));
  });

  test("falls back when the flag is absent", () => {
    assert.equal(flagValue(["--write"], "--prefix", "latest/"), "latest/");
    assert.equal(flagValue([], "--prefix", "latest/"), "latest/");
    assert.equal(flagValue(["--write"], "--prefix"), undefined);
  });

  test("a following flag is not swallowed as the value", () => {
    // `--prefix --write` must fall back, not download a prefix named "--write".
    assert.equal(
      flagValue(["--prefix", "--write"], "--prefix", "latest/"),
      "latest/",
    );
    // Trailing flag with nothing after it.
    assert.equal(
      flagValue(["--write", "--prefix"], "--prefix", "latest/"),
      "latest/",
    );
  });

  test("an explicit empty value stays empty rather than falling back", () => {
    // `--prefix=` is a caller saying "empty", which is distinct from omitting it.
    assert.equal(flagValue(["--prefix="], "--prefix", "latest/"), "");
  });

  test("the equals form wins when both are somehow present", () => {
    assert.equal(
      flagValue(["--prefix=a/", "--prefix", "b/"], "--prefix"),
      "a/",
    );
  });

  test("matches only the requested flag, not a prefix of another", () => {
    // `--out` must not be satisfied by `--output=...`.
    assert.equal(
      flagValue(["--outfile=x"], "--out", "tmp/r2-download"),
      "tmp/r2-download",
    );
  });
});
