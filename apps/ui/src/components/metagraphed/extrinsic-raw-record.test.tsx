import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { extrinsicRawUrl } from "@/lib/metagraphed/extrinsic-raw";
import { ExtrinsicRawRecord } from "./extrinsic-raw-record";

describe("exact API response cache isolation", () => {
  it("does not expose cached text before this reader requests it", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["extrinsic-exact-api-response", extrinsicRawUrl("0xabc")],
      "previous response",
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ExtrinsicRawRecord reference="0xabc" />
      </QueryClientProvider>,
    );
    expect(html).toContain("Load exact API response");
    expect(html).not.toContain("previous response");
    expect(html).not.toContain("Copy exact API response text");
    client.clear();
  });
});
