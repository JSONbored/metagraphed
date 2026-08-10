// The event price line, TAO and its fiat companion (#8369, #8602).
//
// Both halves follow the same rule and it is the point of the component: a
// figure that does not exist renders NOTHING. For most event kinds a price is
// not missing, it simply does not exist, and an em-dash placeholder would
// imply a value being withheld. The fiat leg inherits that rule for a second
// reason -- an event predating the index has no dollar price, and inventing
// one from the oldest rate would be fabrication.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceAtTx, priceAtTxTooltip, usdAtTxTooltip } from "./price-at-tx";

const markup = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("the TAO price line", () => {
  it("renders the price with its basis in the tooltip", () => {
    const html = markup(<PriceAtTx price={0.0284} basis="trade_exact" blockNumber={8454388} />);
    expect(html).toContain("0.0284");
    expect(html).toContain("execution price");
  });

  it("renders NOTHING when there is no derivable price", () => {
    // A transfer, a registration, root (no AMM pool), or a malformed leg.
    for (const absent of [null, undefined, Number.NaN]) {
      expect(markup(<PriceAtTx price={absent} />)).toBe("");
    }
  });
});

describe("the fiat companion (#8602)", () => {
  it("renders beside the TAO price when the API resolved one", () => {
    const html = markup(<PriceAtTx price={0.0284} basis="trade_exact" usd={5.8} />);
    expect(html).toContain("0.0284");
    expect(html).toContain("5.8");
  });

  it("renders NOTHING for the dollar leg when there is no rate", () => {
    // An event predating the index has no dollar price. The TAO side is
    // untouched -- a missing rate says nothing about the trade's own price.
    const html = markup(<PriceAtTx price={0.0284} basis="trade_exact" usd={null} />);
    expect(html).toContain("0.0284");
    expect(html).not.toContain("$");
  });

  it("treats a non-finite usd as absent rather than rendering NaN", () => {
    const html = markup(<PriceAtTx price={0.0284} basis="trade_exact" usd={Number.NaN} />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("$");
  });

  it("no TAO price means the whole line is absent, fiat included", () => {
    // The fiat leg is secondary text under a price; with no price there is
    // nothing for it to qualify.
    expect(markup(<PriceAtTx price={null} usd={5.8} />)).toBe("");
  });
});

describe("what the tooltips have to say", () => {
  it("states the dollar leg is the LESS precise of the two", () => {
    // The misunderstanding this exists to prevent: a reader assuming the USD
    // figure is as exact as the trade's own execution price. They are
    // different kinds of claim and the tooltip is where that is said.
    const tip = usdAtTxTooltip(5.8, "2026-08-10T09:00:00.000Z", 2);
    expect(tip).toContain("at or before this trade");
    expect(tip).toContain("2 qualifying liquidity pools");
    expect(tip).toContain("alpha price is exact");
    expect(tip).toContain("less precise");
  });

  it("degrades cleanly when there is no provenance to state", () => {
    const tip = usdAtTxTooltip(5.8, null, null);
    expect(tip).toContain("5.8");
    expect(tip).not.toContain("observed");
    expect(tip).not.toContain("qualifying");
  });

  it("says pool, not pools, when there is one", () => {
    expect(usdAtTxTooltip(5.8, null, 1)).toContain("1 qualifying liquidity pool");
    expect(usdAtTxTooltip(5.8, null, 1)).not.toContain("pools");
  });

  it("a zero pool count is treated as no provenance, not as 'across 0'", () => {
    expect(usdAtTxTooltip(5.8, null, 0)).not.toContain("qualifying");
  });

  it("the TAO tooltip still names its own basis distinctly", () => {
    // The two vocabularies must not blur: trade_exact is the row's own legs.
    expect(priceAtTxTooltip(0.0284, "trade_exact", 1)).toContain("Not a bucket average");
    expect(priceAtTxTooltip(0.0284, "root_no_pool", 1)).not.toContain("execution price");
  });
});
