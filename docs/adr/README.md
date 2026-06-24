# Architecture Decision Records

Why metagraphed is built the way it is. Each ADR captures one significant
decision — its context, the choice made, and the consequences — so the reasoning
survives even when the code moves on. Skim these before proposing a structural
change.

| ADR                                         | Decision                                                                                       | Status                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [0001](0001-r2-only-data-artifacts.md)      | R2-only data artifacts; commit inputs + contract, self-sufficient publish                      | Accepted · implemented (publish trigger superseded by [0007](0007-event-driven-publish.md)) |
| [0002](0002-live-operational-health.md)     | Live operational health — 15-min cron prober → D1/KV → served live                             | Accepted · implemented                                                                      |
| [0003](0003-ai-native-layer.md)             | AI-native layer — agent catalog, `llms.txt`, remote MCP server                                 | Accepted · implemented (AI-1–AI-3; later AI phases tracked in issues)                       |
| [0004](0004-candidate-trust-model.md)       | Candidate → verified-surface trust model                                                       | Accepted                                                                                    |
| [0005](0005-release-process.md)             | Release-channel policy (npm / PyPI / hosted) — runbook in [`RELEASING.md`](../../RELEASING.md) | Accepted                                                                                    |
| [0006](0006-provenance-tiered-storage.md)   | Provenance-tiered storage — git for human inputs, R2/D1 for machine data                       | Accepted (partial) · step 1 (#571) shipped, steps 2–4 pending                               |
| [0007](0007-event-driven-publish.md)        | Event-driven data publish + daily floor (replaces the 6h cron)                                 | Accepted · implemented (#1250)                                                              |
| [0008](0008-subnet-data-model.md)           | Subnet data model — one file per subnet; `authority` + `review` as fields                      | Accepted · implemented (#1678 + surface migration)                                          |
| [0009](0009-autonomous-review-gate.md)      | Autonomous contributor review gate (the Gittensory Gate)                                       | Accepted · in use                                                                           |
| [0010](0010-chain-direct-block-explorer.md) | Chain-direct block explorer + first-party event indexer                                        | Accepted (partial) · ingestion/serving shipped, deep history pending infra                  |

## Keeping these current

ADRs are **immutable records of a decision at a point in time** — don't rewrite an
accepted one when reality moves. Instead:

- **A decision is replaced** → write a new ADR and set the old one's status to
  _Superseded by ADR-NNNN_ (see 0001 → 0007).
- **A decision lands or stalls** → update only its **Status** line, and the row
  above, so this index reflects reality at a glance.

New ADR: copy the header shape (Title · Status · Date · Context · Decision ·
Consequences), take the next number, and add a row here.
