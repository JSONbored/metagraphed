import { z } from "zod";

const ModelName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"));
const ProviderName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const Price = z.number().finite().nonnegative();

export const InferenceIdentitySchema = z.object({
  embedding: z.object({
    provider: ProviderName,
    model: ModelName,
    dimensions: z.number().int().min(1).max(4096),
  }),
  completion: z.object({
    provider: ProviderName,
    model: ModelName,
    inputUsdPerMillion: Price.optional(),
    outputUsdPerMillion: Price.optional(),
  }),
});
export type InferenceIdentity = z.infer<typeof InferenceIdentitySchema>;

export const InferenceMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type InferenceMessage = z.infer<typeof InferenceMessageSchema>;
