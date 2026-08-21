// GET /api/v1/chain/subnet-price-share-composition (#11550).
//
// A compact, chart-oriented projection of artifact-normalized moving-price
// captures. It deliberately does not call a value alpha stake, network stake,
// runtime v440 Stage-1 share, or final TAO emission when the source cannot
// support that claim.
import { z } from "zod";

const IsoDaySchema = z.iso.date();
const PriceShareSchema = z.number().min(0).max(1);

const SubnetPriceShareCompositionSeriesSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["subnet", "other"]),
    netuid: z.int().min(0).nullable(),
    label: z.string().nullable(),
    reference_price_share: PriceShareSchema,
  })
  .strict()
  .describe(
    "A stable netuid chart series selected from one observed writer timestamp. It is not an identity-history join, so a reused netuid is not asserted to represent one project throughout the series. `other` is the non-negative six-decimal residual against the source's global artifact-normalized price-share unit; it is not a persisted bucket or the sum of stored unselected rows. Root remains in the source denominator when it reports a price.",
  );

const SubnetPriceShareCompositionValueSchema = z
  .object({
    series_id: z.string().min(1),
    price_share: PriceShareSchema,
    source: z.enum(["recorded", "derived"]),
  })
  .strict()
  .describe(
    "One series inside one observed writer timestamp. Subnet values are recorded artifact-normalized moving-price shares; `other` is the derived non-negative six-decimal residual. A day whose selected recorded values exceed one is omitted rather than normalized or silently clamped.",
  );

const SubnetPriceShareCompositionDaySchema = z
  .object({
    snapshot_date: IsoDaySchema,
    writer_captured_at: z.iso.datetime(),
    priced_subnet_count: z.int().min(1),
    observed_price_share_total: z.number().min(0),
    values: z.array(SubnetPriceShareCompositionValueSchema),
  })
  .strict()
  .describe(
    "One UTC day whose priced observations share one writer_captured_at and sum to one within the source's six-decimal rounding envelope. observed_price_share_total is a diagnostic of the stored shares, not a count of chain coverage.",
  );

export const SubnetPriceShareCompositionArtifactSchema = z
  .object({
    schema_version: z.int(),
    metric: z.literal("artifact_normalized_moving_price_share"),
    observation_basis: z
      .literal("estimated_observed_price_set")
      .describe(
        "Legacy daily snapshots do not include a completed-pass manifest. This is an estimated normalized observed-price set, not proof that every chain subnet was present in the source economics artifact. A shared writer timestamp can detect certain mixed writes but is not a source artifact identifier.",
      ),
    target_day_count: z.int().min(1),
    series_limit: z.int().min(1),
    reference_day: IsoDaySchema.nullable(),
    reference_writer_captured_at: z.iso.datetime().nullable(),
    point_count: z.int().min(0),
    oldest_day: IsoDaySchema.nullable(),
    newest_day: IsoDaySchema.nullable(),
    series: z.array(SubnetPriceShareCompositionSeriesSchema),
    days: z.array(SubnetPriceShareCompositionDaySchema),
  })
  .strict()
  .describe(
    "Bounded recorded artifact-normalized moving-price-share composition. `emission_share` is alpha price / sum of reported alpha prices from the legacy economics artifact; it includes Root when Root reports a price and does not preserve historic runtime eligibility inputs. It is deliberately not the runtime v440 Stage-1 share, final TAO emission, or a certified complete daily snapshot pass. The stable netuid cohort comes from reference_day; this route does not join identity history, so it does not claim a reused netuid is one project throughout the series. A day is omitted unless its numeric shares have one persisted writer_captured_at value and sum to one within six-decimal rounding tolerance. The timestamp check detects certain mixed writes but does not certify one upstream artifact or complete chain coverage.",
  );

export type SubnetPriceShareCompositionArtifact = z.infer<
  typeof SubnetPriceShareCompositionArtifactSchema
>;
