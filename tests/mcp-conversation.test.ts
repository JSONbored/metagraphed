import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  acceptedMcpConversationId,
  mcpConversationHandle,
} from "../src/mcp-conversation.ts";

const HANDLE = "0198f2d6-abcd-7123-8456-789abcdef012";

describe("MCP conversation handles", () => {
  test("only UUIDv7 echoes are accepted and case does not split a conversation", () => {
    assert.equal(
      acceptedMcpConversationId(` ${HANDLE.toUpperCase()} `),
      HANDLE,
    );
    assert.deepEqual(mcpConversationHandle(HANDLE), {
      conversationId: HANDLE,
      conversationIdAccepted: true,
    });
    for (const value of [
      undefined,
      null,
      42,
      {},
      "",
      "chat-1",
      HANDLE.replace("-7123-", "-4123-"),
      HANDLE.replace("-8456-", "-7456-"),
      `${HANDLE}-extra`,
    ]) {
      assert.equal(acceptedMcpConversationId(value), undefined);
      const created = mcpConversationHandle(value);
      assert.equal(created.conversationIdAccepted, false);
      assert.equal(
        acceptedMcpConversationId(created.conversationId),
        created.conversationId,
      );
    }
  });

  test("independent first calls receive distinct handles even in the same millisecond", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_790_579_000_000);
    try {
      const first = mcpConversationHandle(undefined).conversationId;
      const second = mcpConversationHandle(undefined).conversationId;
      assert.notEqual(first, second);
      assert.equal(
        Number.parseInt(first.slice(0, 13).replace("-", ""), 16),
        Date.now(),
      );
      assert.equal(first[14], "7");
    } finally {
      now.mockRestore();
    }
  });
});
