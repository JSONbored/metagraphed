// Personal (coldkey) chain identity (#4324/5.1) — one row per account, latest
// only. Distinct from subnet identity (SubtensorModule::SubnetIdentitiesV3,
// src/subnet-identity-history.mjs / src/chain-identity-history.mjs) — this is
// the identity a coldkey attaches to itself. Field mapping documented in
// scripts/fetch-account-identity.py's docstring and
// migrations/0039_account_identity.sql. Mirrors NEURON_INSERT_COLUMNS's role
// in src/metagraph-neurons.mjs — the full column set written by the staged-
// load path (loadStagedAccountIdentity, workers/request-handlers/staging.mjs).
//
// Capture-only for now (#4325): no read/format/build/route functions here yet
// — those land with the serving route in #4328 (5.4), mirroring how
// subnet_hyperparams's load contract (this same INSERT_COLUMNS shape) landed
// in 1.2/1.3 before formatSubnetHyperparams/buildSubnetHyperparams/
// loadSubnetHyperparams arrived with the route in 1.4.

export const ACCOUNT_IDENTITY_INSERT_COLUMNS = [
  "account",
  "name",
  "url",
  "github",
  "image",
  "discord",
  "description",
  "additional",
  "captured_at",
];
