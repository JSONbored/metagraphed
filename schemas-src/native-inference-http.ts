import { z } from "zod";

/** Native HTTP wire validation stays outside the Worker module graph. */
export const OpenAiEmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number().finite()).max(4096),
      }),
    )
    .max(100),
});

export const OpenAiCompletionResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
