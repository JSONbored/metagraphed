import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/** Only an internal handler can attach native content. Upstream JSON cannot
 * forge this wrapper or bypass the ordinary structured-output validation. */
export class McpContentResult {
  constructor(
    readonly value: Record<string, unknown>,
    readonly content: ContentBlock,
  ) {}
}
