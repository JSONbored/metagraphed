// The cross-repository conformance-fixture identity (metagraphed-infra#883).
//
// JSONbored/subnet-ops executes this repo's native assembly against a
// disposable PostgreSQL 18 fixture and refuses any descriptor whose identity
// differs from its own pin (metagraphed/native-app/ci.py, exercised by
// shared/infra/terraform/ci/test_metagraphed_native.py). Each repository
// carries the pin SEPARATELY and on purpose: a contract bump that lands on
// one side alone must fail that side's CI visibly instead of drifting, so a
// bump is always a deliberate reviewed diff to this module here and to the
// fleet-side pin there. Public builds have no fleet checkout or credentials,
// so nothing here fetches the other side's copy -- the paired-pin discipline
// IS the check.
export const NATIVE_CONFORMANCE_CONTRACT = Object.freeze({
  /** Descriptor `format` of the public serving-conformance fixture. */
  publicFixtureFormat: "metagraphed.native-public-conformance-fixture.v1",
  /** Descriptor `format` of the stake-conformance fixture. */
  stakeFixtureFormat: "metagraphed.native-stake-conformance-fixture.v1",
  /** Serving-contract revision both descriptors must carry. */
  schemaContract: 4,
  /** PostgreSQL major the fixtures qualify against: [18.0, 19.0). */
  databaseVersionFloor: 180000,
  databaseVersionCeiling: 190000,
  /** The restricted read-only role the fixtures execute serving reads as. */
  serveLogin: "metagraphed_serve_login",
});
