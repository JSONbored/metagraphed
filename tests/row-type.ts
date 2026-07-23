// Shared dynamic-JSON row type for test fixtures/mocks: registry snapshots,
// D1/Postgres-shaped rows, KV-stored payloads, and other untrusted or
// intentionally-loose test data. Mirrors the readJson/readArtifactJson
// precedent in scripts/lib.ts -- never used for production control flow,
// only to keep test fixtures from fighting strict mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

// A deliberately loose callable type for test doubles (globalThis.fetch
// stubs, D1/KV method mocks, etc.) whose real counterpart's exact call
// signature (e.g. `typeof fetch`'s overloads) is far stricter than any
// individual test's stub needs to satisfy. Declaring a helper's stub
// parameter as this type keeps contextual typing flowing to each call
// site's inline stub body (so its own params aren't implicit-any) without
// forcing every stub to structurally match the real signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...args: any[]) => any;

// A partial Cloudflare Worker `Env` (the wrangler-generated global ambient
// interface in workers/worker-configuration.d.ts, ~45 required bindings) for
// tests that only stub the handful of bindings the code path under test
// actually reads. Route handlers already converted to .ts declare `env: Env`
// strictly; production callers always get the real, complete Env from the
// Worker runtime, so this cast is test-only scaffolding, never a production
// shortcut.
export function mockEnv(overrides: Record<string, unknown> = {}): Env {
  return overrides as unknown as Env;
}

// This codebase's Response/Request type declarations resolve `res.json()` to
// `Promise<unknown>`, not `Promise<any>` -- every test that reads a handler's
// JSON body and then accesses a field on it needs this cast once at the read
// site rather than fighting `unknown` per property.
export async function jsonBody(res: Response): Promise<Row> {
  return (await res.json()) as Row;
}
