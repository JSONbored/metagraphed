import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/** Only an internal handler can attach native content. Upstream JSON cannot
 * forge this wrapper or bypass the ordinary structured-output validation. */
export class McpContentResult {
  readonly value: Record<string, unknown>;
  readonly content: ContentBlock;

  constructor(value: Record<string, unknown>, content: ContentBlock) {
    this.value = value;
    this.content = content;
  }
}

/** SDK-validated upstream blocks, retained once as native MCP content. */
export class McpForwardedResult {
  readonly value: Record<string, unknown>;
  readonly content: ContentBlock[];
  readonly isError: boolean;
  constructor(
    value: Record<string, unknown>,
    content: ContentBlock[],
    isError: boolean,
  ) {
    this.value = value;
    this.content = content;
    this.isError = isError;
  }
}
