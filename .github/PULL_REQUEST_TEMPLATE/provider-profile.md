## Provider Profile Submission

This PR adds or updates exactly one provider/operator profile review file.

## Provider

- Provider slug:
- Provider name:
- Provider kind:
- Website URL:
- GitHub URL:
- Contact URL:

## Checklist

- [ ] This PR changes exactly one `registry/providers/*.json` file.
- [ ] I generated the file with `npm run provider:new` or matched
      `docs/examples/submissions/direct-provider-profile.json`.
- [ ] The profile contains only public-safe metadata.
- [ ] The provider/operator identity is supported by a public website, GitHub
      org/repo, docs page, status page, or contact page.
- [ ] This does not claim endpoint health, uptime, latency, archive support, or
      pool eligibility.
- [ ] This does not include secrets, wallet/PAT data, private URLs, private
      dashboards, validator internals, or generated artifacts.

## Gate Expectations

Provider profile submissions always route to manual/private review. Approved
profiles can support future endpoint submissions, but they do not directly make
any endpoint pool-eligible.

## Validation

- [ ] `npm run submission:pr -- --changed-files <changed-files.txt>`
- [ ] `npm run validate:intake`
- [ ] `npm run scan:public-safety`
