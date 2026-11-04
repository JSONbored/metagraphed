import {
  InferenceIdentitySchema,
  type InferenceIdentity,
  type InferenceMessage,
} from "../schemas-src/native-inference.ts";

export interface AiInference {
  readonly identity: {
    readonly embedding: Readonly<InferenceIdentity["embedding"]>;
    readonly completion: Readonly<InferenceIdentity["completion"]>;
  };
  embed(text: readonly string[], signal?: AbortSignal): Promise<{ data: number[][] }>;
  complete(
    messages: readonly InferenceMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<{
    response: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
}

/** Explicit native selection; malformed configuration cannot reach Workers AI. */
export function selectedAiInference(env: unknown): AiInference | undefined {
  if (!env || typeof env !== "object") return;
  const selected = (env as { AI_INFERENCE?: AiInference }).AI_INFERENCE;
  if (selected === undefined) return;
  if (
    !selected ||
    typeof selected.embed !== "function" ||
    typeof selected.complete !== "function"
  )
    throw new TypeError("Selected inference capability is invalid");
  InferenceIdentitySchema.parse(selected.identity);
  return selected;
}
