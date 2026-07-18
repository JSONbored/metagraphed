import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6395: the /blocks numeric filters (block_start, block_end, min_extrinsics,
// min_events) passed the raw SearchInput value straight through, so typing or
// pasting a non-digit character reached the query string and tripped the
// backend's strict numeric validation (#2310) as a live 400 through the page's
// error boundary, instead of being sanitized on input like /endpoints' netuid
// filter (endpoints.tsx:843) already is.
//
// Source assertion: these onChange handlers only run from a live keystroke/paste
// event, so a rendered test can't reach them without a full router harness;
// this suite is node-environment, matching validators-index-empty-action.test.ts.
const blocks = readFileSync(fileURLToPath(new URL("./blocks.index.tsx", import.meta.url)), "utf8");

describe("/blocks numeric filter sanitization (#6395)", () => {
  it.each(["block_start", "block_end", "min_extrinsics", "min_events"])(
    "%s's onChange strips non-digit characters before updating search state",
    (field) => {
      // `value={search.<field>}` only occurs once, inside the SearchInput JSX --
      // blocksQueryParams() above references `search.<field>` too, but never as
      // `value={...}`, so this anchor lands on the onChange right after it.
      const marker = `value={search.${field}}`;
      const start = blocks.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const onChangeSnippet = blocks.slice(start, start + 200);
      expect(onChangeSnippet).toMatch(
        new RegExp(
          `onChange=\\{\\(v\\) => setSearch\\(\\{ ${field}: v\\.replace\\(/\\[\\^0-9\\]/g, ""\\), offset: 0 \\}\\)\\}`,
        ),
      );
    },
  );
});
