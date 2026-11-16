/** The index operations used by registry embedding sync and retrieval. */
export type SemanticIndex = Pick<
  Vectorize,
  "upsert" | "deleteByIds" | "query"
> & {
  readonly identity?: Readonly<{
    name: string;
    model: string;
    dimensions: number;
  }>;
};

export function selectedSemanticIndex(env: unknown): SemanticIndex | undefined {
  if (!env || typeof env !== "object") return undefined;
  const selected = (env as { SEMANTIC_INDEX?: SemanticIndex }).SEMANTIC_INDEX;
  if (selected === undefined) return undefined;
  if (
    !selected ||
    typeof selected.upsert !== "function" ||
    typeof selected.deleteByIds !== "function" ||
    typeof selected.query !== "function"
  ) {
    throw new TypeError("Selected semantic index is invalid");
  }
  return selected;
}
