import { describe, expect, it } from "vitest";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { parseAppSearch } from "./search-params";

const literalQueries = [
  "404",
  "0",
  "-0",
  "1e3",
  "1e309",
  "9007199254740993",
  "true",
  "false",
  "null",
  " 404 ",
  " [ 1, false, null ] ",
  ' { "b": 2, "a": 1 } ',
  "?x=1&y=two+three#frag%_",
];

describe("text query URL parsing", () => {
  it.each(literalQueries)("preserves raw q text: %s", (q) => {
    expect(parseAppSearch("?" + new URLSearchParams({ q })).q).toBe(q);
  });

  it.each([...literalQueries, '"quoted"', "", "line\nfeed"])(
    "round-trips the existing router serializer: %s",
    (q) => {
      expect(parseAppSearch(defaultStringifySearch({ q })).q).toBe(q);
    },
  );

  it("keeps existing JSON-string links decoded and preserves the raw length bound", () => {
    expect(parseAppSearch("?q=%22404%22").q).toBe("404");
    expect(parseAppSearch("?q=%22true%22").q).toBe("true");
    expect(parseAppSearch("?q=" + "9".repeat(201)).q).toHaveLength(201);
  });

  it("leaves absent/repeated q and every unrelated typed parameter unchanged", () => {
    for (const query of [
      "",
      "?limit=25&enabled=true&none=null&filters=%5B1%2C2%5D&provider=404",
      "?q=404&q=true&limit=25",
      "?q=&q=0",
    ]) {
      expect(parseAppSearch(query)).toEqual(defaultParseSearch(query));
    }
    const query = "?q=404&limit=25&enabled=false&netuid=0&filters=%7B%22a%22%3A1%7D";
    const { q: _q, ...rest } = parseAppSearch(query);
    const parsed: Record<string, unknown> = defaultParseSearch(query);
    const { q: _oldQ, ...original } = parsed;
    expect(rest).toEqual(original);
  });
});
