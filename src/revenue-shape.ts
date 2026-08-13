// #10525: the payload-shape vocabulary, in one place so the extractor and any
// future consumer import it rather than restating the union.
import { QUERY_ENUMS } from "../schemas-src/query-enums.ts";

// The vocabulary, derived from its owner (#10987): subnet-detail.ts declared
// the same three shapes inline and nothing compared the two.
export const REVENUE_SHAPES = QUERY_ENUMS.revenueShape;
export type RevenueShape = (typeof REVENUE_SHAPES)[number];
