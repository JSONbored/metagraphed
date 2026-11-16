import { z } from "zod";

// Vectorize accepts null for absent document fields although its published
// TypeScript metadata type omits null. Keep that existing wire behavior.
export const SemanticIndexMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
);
