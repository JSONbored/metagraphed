import { z } from "zod";

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Physical byte positions include the page header. Row positions are local
 * to a row group. Only flat, non-repeated columns are supported in v1. */
export const ParquetPageLocationSchema = z.strictObject({
  offset,
  bytes: offset.positive(),
  row: offset,
  rows: offset.positive(),
});

/** The footer and every page location belong to one immutable object. Keeping
 * its identity in the index prevents a replaced object from answering with
 * another generation's physical row positions. */
export const ParquetPageIndexSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().min(1),
  etag: z.string().min(1),
  bytes: offset.min(12),
  rows: offset,
  footer: z
    .string()
    .min(12)
    .max(8 * 1024 * 1024),
  groups: z.array(
    z.strictObject({
      rows: offset,
      columns: z.record(z.string(), z.array(ParquetPageLocationSchema)),
    }),
  ),
});

export type ParquetPageIndex = z.infer<typeof ParquetPageIndexSchema>;
