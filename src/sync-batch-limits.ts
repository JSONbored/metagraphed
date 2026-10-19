// Shared admission inputs and transformed queue budget. Keep this leaf free of
// parser/economics imports: the compression transport does not need their graph.
export const CHAIN_DETAIL_SYNC_MAX_BODY_BYTES = 16_000_000;
export const CHAIN_DETAIL_SYNC_MAX_BLOCKS = 16;
export const CHAIN_DETAIL_SYNC_MAX_ROWS = 80_000;

/** Conservative UTF-8 ceiling for every currently admitted chain-detail POST
 * after parsing, normalization and economics enrichment. This deliberately uses
 * the HTTP 80,000-row bound, not the independent 5,000-row consumer validator.
 * The byte accounting and its assumptions are in docs/sync-batch-decoding.md. */
export const SYNC_BATCH_MAX_DECODED_BYTES =
  4 * CHAIN_DETAIL_SYNC_MAX_BODY_BYTES +
  192 * CHAIN_DETAIL_SYNC_MAX_ROWS +
  2_048 * CHAIN_DETAIL_SYNC_MAX_BLOCKS +
  256;
