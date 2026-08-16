/**
 * The `DurableObjectState` surfaces the hubs actually use.
 *
 * ## Why not just `DurableObjectState`
 *
 * Every hub in this directory declared its constructor as taking the whole
 * thing, and every double outside the runtime therefore had to be asserted
 * into it -- `{ storage: inMemoryDoStorage() } as unknown as DurableObjectState`
 * in validate-mcp.ts, three times. That assertion is not a formality. It said
 * the object had `blockConcurrencyWhile`, `abort`, `id`, `container`, `props`,
 * a full `DurableObjectStorage` with fifteen members, and it said so about an
 * object with one key. Nothing checked the claim, so nothing noticed when it
 * stopped being close to true:
 *
 *   - all three hubs call `state.waitUntil` for telemetry, inside a `try` that
 *     swallows the resulting TypeError. No double supplied it, so every
 *     validated MCP run emitted no usage telemetry at all and reported success.
 *   - `ChainFirehoseHub` reads and writes `state.storage` on the head-poll
 *     path. Its double was `{ getWebSockets: () => [] }` -- no storage at all.
 *
 * Both are the same failure: an assertion describing a shape nobody built.
 *
 * ## The shape of the fix
 *
 * Each hub names the surface it depends on, following `WaitUntilLike` and
 * `HyperdriveLike` in src/pg-sql.ts. A real `DurableObjectState` satisfies
 * these structurally, so the runtime is unaffected and Cloudflare still
 * constructs the classes exactly as before. A double now has to implement what
 * the hub calls -- and when a hub starts calling something new, the double
 * fails to compile instead of throwing into a `catch` at runtime.
 *
 * These are deliberately per-hub rather than one shared `HubState`. The
 * storage surfaces genuinely differ: the session and subnet hubs use the
 * multi-key `get(keys)`/`put(entries)` overloads, the firehose hub uses the
 * single-key `get(key)`/`put(key, value)` pair plus the alarm accessors. One
 * merged interface would oblige every double to implement all of it, which is
 * how the assertion got there in the first place.
 *
 * ## `unknown`, not a type argument
 *
 * `DurableObjectStorage.get` is generic, and the hubs used to name the type
 * they expected -- `get<number>("head:last_seen")`. Nothing enforces that. The
 * value was written by a PREVIOUS deploy, so its shape is a contract with code
 * that is no longer running, and the type argument is a claim about it rather
 * than a check of it. mcp-session-hub.ts already says this at length in its own
 * hydrate(), and then parses. These interfaces return `unknown` so every reader
 * has to do the same thing, which also happens to be the only signature a
 * double can implement without asserting.
 */
import type { WaitUntilLike } from "../src/pg-sql.ts";

/** Deferred telemetry. A Durable Object has no `ExecutionContext`, so the hubs
 *  park fire-and-forget work on the state itself. */
export type HubStateBase = WaitUntilLike;

/** Multi-key storage: `get(keys)` returns a Map, `put(entries)` takes a record.
 *  Both are real `DurableObjectStorage` overloads. */
export interface KeyedDoStorage {
  get(keys: string[]): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
}

/** What `McpSessionHub` uses: keyed storage plus the idle-expiry alarm. */
export interface McpSessionHubState extends HubStateBase {
  storage: KeyedDoStorage & {
    setAlarm(scheduledTime: number | Date): Promise<void>;
  };
}

/** What `SubnetStatusHub` uses. No alarm: its state expires with the sessions
 *  that hold it, not on a timer. */
export interface SubnetStatusHubState extends HubStateBase {
  storage: KeyedDoStorage;
}

/** What `ChainFirehoseHub` uses: single-key storage for the head cursor, the
 *  alarm accessors that drive the poll loop, and the hibernatable-WebSocket
 *  pair that lets it survive eviction with connections open. */
export interface ChainFirehoseHubState extends HubStateBase {
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}
