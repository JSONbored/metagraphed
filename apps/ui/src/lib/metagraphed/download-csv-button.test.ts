import { describe, expect, it } from "vitest";

import { DownloadCsvButton } from "./download-csv-button";

describe("DownloadCsvButton", () => {
  it("exports a component function", () => {
    expect(typeof DownloadCsvButton).toBe("function");
  });
});
