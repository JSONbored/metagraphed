import { describe, expect, it } from "vitest";
import { providersCsvQueryParams } from "./providers-csv-params";

describe("providersCsvQueryParams", () => {
  it("forwards API-supported kind and authority filters", () => {
    expect(
      providersCsvQueryParams({
        kind: "subnet-team",
        authority: "official",
        sort: "name",
      }),
    ).toEqual({
      kind: "subnet-team",
      authority: "official",
      sort: "name",
    });
  });

  it("drops the UI-only `high` authority shortcut", () => {
    expect(providersCsvQueryParams({ authority: "high" })).toEqual({});
  });

  it("omits client-only sort keys the API cannot honor", () => {
    expect(providersCsvQueryParams({ sort: "surfaces" })).toEqual({});
    expect(providersCsvQueryParams({ sort: "endpoints" })).toEqual({});
  });

  it("returns an empty object when nothing is filterable", () => {
    expect(providersCsvQueryParams({})).toEqual({});
  });
});
