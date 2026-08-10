// #10525: the payload-shape vocabulary, in one place so the extractor and any
// future consumer import it rather than restating the union.
export const REVENUE_SHAPES = ["flat-array", "keyed-map", "scalar"] as const;
export type RevenueShape = (typeof REVENUE_SHAPES)[number];
