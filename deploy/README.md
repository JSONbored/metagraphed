# `deploy/`

The Docker build inputs for the box-side data-refresh jobs, and nothing else.

| File                           | Built by                                            |
| ------------------------------ | --------------------------------------------------- |
| `data-refresh-node.Dockerfile` | `metagraphed-infra`'s `data-refresh-node` role      |
| `economics-refresh.Dockerfile` | `metagraphed-infra`'s `data-refresh-economics` role |
| `metagraph-fetch.Dockerfile`   | `metagraphed-infra`'s `data-refresh-cron` role      |
| `docker-compose.yml`           | the self-hosted topology, retired 2026-08-04        |

**These three files are canonical here, and are byte-copied into
`metagraphed-infra` under `roles/*/files/`** together with their entrypoints in
`scripts/`. That repo's `check-vendored-sync.py` compares every pair against
this repo's `main` and fails on any difference, so a fix belongs **here first**
and is re-vendored afterwards — never the other way round.

## The operator runbook moved

The bare-metal runbook that used to be this file — box roles, provisioning
commands, Ansible role names, recovery procedures — is now
`docs/self-hosted-deployment-runbook.md` in `JSONbored/metagraphed-infra`,
alongside the configuration it describes.

The estate it described was decommissioned on 2026-08-04 and is Cloudflare-only:
Workers, D1, R2, KV, Queues and Durable Objects. The architecture and rationale
remain public in
[ADR 0014](../docs/adr/0014-chain-data-infrastructure-and-postgres-cutover.md);
only the operator procedure moved.

See [ADR 0028](../docs/adr/0028-public-private-repo-boundary.md) for the rule.
