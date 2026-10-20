// Exact public release-source identities. Sources are inert test data, never imported.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const OWNER_PG_SOURCES = {
  "pg/lib/stream.js":
    "0bd4001775301604ddf7c94152e05f6f30a9354876717bdae2ab636d00eb12ba",
  "pg/lib/client.js":
    "86cda0e1fda47e03d27dde65f10c7b9d597f7411f77ed853c8d27d5f150978a2",
  "pg/lib/query.js":
    "4253bb48364243573c330a2d5827a0f306f632f84f5ac56feaa3ac83f2293001",
  "pg/lib/utils.js":
    "97fb5d56e301d00412e85ce91d796a61c79493dc03ae5adc05995ed8a0ed7936",
  "pg-cloudflare/src/index.ts":
    "7b65a719769199ac76b511f9f687b8b20a32ed3d25b08f2cd102893dd46bc158",
  "pg-protocol/src/serializer.ts":
    "bccef3856f9d02da5907cf585f234c21763e02f3cff213beee2270c5ef792089",
} as const;
export function assertOwnerPgSource(
  relative: string,
  bytes: Uint8Array | string,
) {
  assert.ok(Object.hasOwn(OWNER_PG_SOURCES, relative));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    OWNER_PG_SOURCES[relative as keyof typeof OWNER_PG_SOURCES],
  );
}
