/** The KV operations used by application control and registry data. */
export interface AppKv {
  get(
    key: string,
    options?: "text" | { type?: "text"; cacheTtl?: number },
  ): Promise<string | null>;
  get<T = unknown>(
    key: string,
    options: "json" | { type: "json"; cacheTtl?: number },
  ): Promise<T | null>;
  get(
    key: string,
    options: "arrayBuffer" | { type: "arrayBuffer"; cacheTtl?: number },
  ): Promise<ArrayBuffer | null>;
  get(
    key: string,
    options: "stream" | { type: "stream"; cacheTtl?: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      expiration?: number;
      expirationTtl?: number;
      metadata?: unknown;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string | null;
    cursor?: string | null;
    limit?: number;
  }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  /** Native read-and-delete. Legacy bindings retain their existing two calls. */
  consume?(key: string): Promise<string | null>;
}

export interface AppKvEnv {
  CONTROL_KV_STORE?: AppKv;
  METAGRAPH_CONTROL?: Partial<AppKv>;
}

export interface OAuthPendingEnv {
  OAUTH_PENDING_STORE?: AppKv;
  OAUTH_KV?: AppKv;
}
