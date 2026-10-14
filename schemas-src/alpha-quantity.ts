import { z } from "zod";

export const AlphaProvenanceSchema = z
  .object({
    network: z.literal("finney"),
    captured_at: z.string(),
    block_number: z.int().min(0),
    block_hash: z.string(),
    genesis_hash: z.string(),
    spec_version: z.union([z.literal(454), z.literal(478)]),
    code_hash: z.string(),
    metadata_sha256: z.string(),
  })
  .strict();
