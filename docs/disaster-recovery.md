# Disaster recovery

**Moved to `JSONbored/metagraphed-infra` (`docs/disaster-recovery.md`) on 2026-08-07.**

It maps the backup estate — bucket names, the restic repository layout, the
host path holding the repository credentials, and what sharing read access to
`metagraphed-backups` would expose. None of that is a serving-side concern, and
a public map of where every backup lives protects nothing by being public.

Nothing that recovers **this** repo's own state moved: the registry is git, the
published artifacts are rebuilt by `npm run build`, and every Cloudflare
resource is declared in the `wrangler.*.jsonc` configs next to it.

See [ADR 0028](adr/0028-public-private-repo-boundary.md) for the rule that
decides which side a document belongs on.
