/**
 * PostHog's stateless conversation handle. It is caller-controlled analytics
 * metadata, never an identity, credential, rate-limit key or billing signal.
 */
const CONVERSATION_HANDLE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function acceptedMcpConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return CONVERSATION_HANDLE.test(id) ? id : undefined;
}

export function mcpConversationHandle(value: unknown): {
  conversationId: string;
  conversationIdAccepted: boolean;
} {
  const accepted = acceptedMcpConversationId(value);
  if (accepted) {
    return { conversationId: accepted, conversationIdAccepted: true };
  }
  // UUIDv7: 48 timestamp bits followed by the version, random bits and the
  // RFC variant. randomUUID supplies the random portion and correct variant.
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const id = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${crypto.randomUUID().slice(15)}`;
  return { conversationId: id, conversationIdAccepted: false };
}
