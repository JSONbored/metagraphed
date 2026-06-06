# Candidate Surfaces

This directory is for unverified subnet interface candidates discovered from third-party sources or community submissions.

Candidate entries are not published as verified registry surfaces. They must stay separate until maintainer review confirms:

- the public URL is live;
- auth and rate-limit requirements are labeled;
- source docs support the claim;
- the probe is safe and read-only;
- no secrets, private dashboards, credentialed flows, or validator-sensitive data are included.

Generated public-source candidates live in `generated/public-sources.json`.

The generated bundle is allowed to contain:

- official/project websites;
- source repositories;
- documentation links;
- dashboards and leaderboard-style URLs;
- public data-artifact URLs.

The generated bundle must not contain owner key fields, contact emails, Discord handles, wallet data, private dashboards, credentialed validator flows, or social-only links.

Allowed states:

- `schema-invalid`
- `schema-valid`
- `maintainer-review`
- `verified`
- `stale`
- `rejected`

Only `verified` candidates should be promoted into curated subnet overlays under `registry/subnets`.
