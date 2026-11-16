import assert from "node:assert/strict";

/** Require the disposable integration service before opening a connection. */
export function pg18FixtureUrl(): URL {
  const supplied = process.env.METAGRAPH_PG18_URL;
  assert.ok(supplied, "METAGRAPH_PG18_URL must name the CI fixture database");
  const url = new URL(supplied);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54329");
  assert.equal(url.pathname, "/metagraphed_pg18_fixture");
  assert.equal(url.username, "metagraphed_fixture");
  assert.equal(url.password, "fixture-only");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  return url;
}
