// `stripTsComments` -- the shared stripper three gates now depend on.
//
// It replaced three byte-identical copies, two of which I had just added while
// fixing the class of defect it serves (a comment naming a symbol reads as a
// reference and fails nothing when the symbol goes). The copies were correct;
// three of them was the problem.
//
// The URL guard is the reason this has its own test rather than being trusted
// to the three call sites: without it a file mentioning `https://` loses the
// rest of that line, so a gate scanning it silently stops seeing code.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { stripTsComments } from "../scripts/lib/source-text.ts";

describe("stripTsComments", () => {
  test("removes line, inline and block comments", () => {
    assert.match(stripTsComments("// gone\nconst a = 1;"), /const a = 1;/);
    assert.doesNotMatch(stripTsComments("// gone\nconst a = 1;"), /gone/);
    assert.doesNotMatch(stripTsComments("const a = 1; // gone"), /gone/);
    assert.doesNotMatch(stripTsComments("const a = /* gone */ 1;"), /gone/);
    // Multi-line block comments too -- the [\s\S] rather than . is why.
    assert.doesNotMatch(
      stripTsComments("/* one\n * two\n */\nconst a = 1;"),
      /two/,
    );
  });

  test("a URL's // is not a comment", () => {
    // THE GUARD. Without the `([^:])` exclusion this line loses everything
    // from `//` onwards, and a gate scanning the file stops seeing the rest.
    const code = 'const docs = "https://example.com/api";\nconst after = 2;';
    const stripped = stripTsComments(code);
    assert.match(stripped, /https:\/\/example\.com\/api/);
    assert.match(stripped, /const after = 2;/);
  });

  test("comments become a SPACE, not nothing", () => {
    // The callers scan the result for tokens, so joining the text either side
    // of a comment could create a match that is not in the source.
    assert.doesNotMatch(stripTsComments("FROM/* x */table"), /FROMtable/);
  });

  test("code either side of a block comment survives", () => {
    const stripped = stripTsComments("const a = 1; /* mid */ const b = 2;");
    assert.match(stripped, /const a = 1;/);
    assert.match(stripped, /const b = 2;/);
  });
});
