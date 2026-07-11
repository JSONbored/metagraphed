import { describe, expect, it } from "vitest";
import { buildCsvDownloadUrl } from "./download-csv-button";

describe("buildCsvDownloadUrl", () => {
  it("appends format=csv to a bare path URL", () => {
    expect(
      buildCsvDownloadUrl("https://api.metagraph.sh/api/v1/surfaces"),
    ).toBe("https://api.metagraph.sh/api/v1/surfaces?format=csv");
  });

  it("preserves existing query params", () => {
    expect(
      buildCsvDownloadUrl(
        "https://api.metagraph.sh/api/v1/surfaces?q=openapi&kind=api&sort=name&order=asc",
      ),
    ).toBe(
      "https://api.metagraph.sh/api/v1/surfaces?q=openapi&kind=api&sort=name&order=asc&format=csv",
    );
  });

  it("overwrites an existing format param with csv", () => {
    expect(
      buildCsvDownloadUrl(
        "https://api.metagraph.sh/api/v1/endpoints?format=json",
      ),
    ).toBe("https://api.metagraph.sh/api/v1/endpoints?format=csv");
  });
});
