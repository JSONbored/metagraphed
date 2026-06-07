## Direct Candidate Submission

This PR adds or updates exactly one public subnet/interface candidate.

## Candidate

- Netuid:
- Kind:
- Public URL:
- Source URL:
- Provider/operator:

## Checklist

- [ ] This PR changes exactly one `registry/candidates/community/*.json` file.
- [ ] I generated the file with `npm run candidate:new` or matched
      `docs/examples/submissions/direct-candidate.json`.
- [ ] The submitted URL is public and safe for read-only probes.
- [ ] The source URL publicly supports the interface claim.
- [ ] This does not require authentication.
- [ ] This does not duplicate an existing Metagraphed surface or candidate.
- [ ] This does not include secrets, wallet/PAT data, private URLs, private
      dashboards, validator internals, or generated artifacts.

## Gate Expectations

Safe app-layer submissions can be AI-reviewed by the private Metagraphed gate
and may be merged automatically by the GitHub App after public checks pass.

Base-layer RPC/WSS/archive endpoints, authenticated surfaces, unknown
providers, identity disputes, and adapter requests route to manual review.

## Validation

- [ ] `npm run submission:pr -- --changed-files <changed-files.txt>`
- [ ] `npm run validate:intake`
- [ ] `npm run scan:public-safety`
