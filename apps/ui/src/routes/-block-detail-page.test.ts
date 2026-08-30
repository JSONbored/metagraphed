import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  fileURLToPath(new URL("./-block-detail-page.tsx", import.meta.url)),
  "utf8",
);
const extrinsicPage = readFileSync(
  fileURLToPath(new URL("./-extrinsic-detail-page.tsx", import.meta.url)),
  "utf8",
);
const blockRoute = readFileSync(
  fileURLToPath(new URL("./blocks.$ref.tsx", import.meta.url)),
  "utf8",
);

describe("block detail loading contract", () => {
  it("uses the endpoint-safe cadence limit instead of requesting 101 blocks", () => {
    expect(page).toContain("limit: CADENCE_BLOCK_LIMIT");
    expect(page).not.toContain("2 * CADENCE_SPAN + 1");
  });

  it("defers secondary forensic data until the reader opens the technical record", () => {
    expect(page).toContain("enabled: shouldFetchEvents");
    expect(page).toContain("enabled: technicalDetailsOpen && number != null");
    expect(page).toContain("Inspect decoded events");
    expect(page).toContain("setTechnicalDetailsOpen(false)");
  });

  it("does not re-request a detail collection when the header confirms it is empty", () => {
    expect(page).toContain("shouldFetchCountedBlockDetail(block?.extrinsic_count)");
    expect(page).toContain("shouldFetchCountedBlockDetail(block?.event_count)");
    expect(page).toContain("loading={shouldFetchExtrinsics && extrinsics.isPending}");
    expect(page).toContain("loading={shouldFetchEvents && events.isPending}");
  });

  it("keeps blocks above the 100-row API ceiling losslessly pageable", () => {
    expect(page).toContain("block?.extrinsic_count");
    expect(page).toContain("extrinsics.hasNextPage");
    expect(page).toContain("extrinsics.fetchNextPage()");
    expect(page).toContain("total={extrinsicTotal ?? undefined}");
    expect(page).toContain("paginate={false}");
  });

  it("primes the first extrinsics page with the header and reuses the shared query entry", () => {
    expect(blockRoute).toContain("await startBlockRouteQueries(context.queryClient, params.ref)");
    expect(blockRoute).toContain("result = await pending.block");
    expect(blockRoute).toContain("void pending.extrinsics");
  });

  it("uses a compact first decoded-event page without losing cursor continuation", () => {
    expect(extrinsicPage).toContain("limit: EXTRINSIC_EVENT_PAGE_SIZE");
    expect(extrinsicPage).not.toContain("{ block, extrinsic: index, limit: 50 }");
    expect(extrinsicPage).toContain("events.fetchNextPage()");
  });

  it("keeps the technical instruments structured while their deferred reads are pending", () => {
    expect(page).toContain('ariaLabel="Events by pallet"');
    expect(page).toContain("loadingItems={4}");
    expect(page).toContain("window.isPending && number != null");
    expect(page).toContain("loading\n              />");
  });

  it("keeps query errors distinct from genuine empty block data", () => {
    expect(page).toContain('context="block extrinsics"');
    expect(page).toContain('context="decoded events"');
    expect(extrinsicPage).toContain('context="decoded events"');
    expect(page).toContain('empty="This block carried no extrinsics."');
    expect(page).toContain('empty="No decoded events for this block."');
    expect(extrinsicPage).toContain('empty="No events are decoded for this extrinsic."');
  });

  it("self-heals only the explicit newest-block detail handoff", () => {
    expect(page).toContain("retry: shouldRetryBlockDetail");
    expect(page).toContain("retryDelay: blockDetailRetryDelay");
    expect(page).toContain("isBlockDetailUnavailable(extrinsics.failureReason)");
    expect(page).toContain("isBlockDetailUnavailable(events.failureReason)");
    expect(page).toContain("<BlockDetailCatchupStatus");
    expect(page).toContain("total={BLOCK_DETAIL_RETRY_COUNT}");
  });
});
