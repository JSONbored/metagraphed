// RETIRED: the per-surface community-candidate intake lane
// (registry/candidates/community/*.json) is gone. Surfaces now live in ONE file
// per subnet — add them directly to registry/subnets/<slug>.json with
// `npm run surface:add`. This stub points contributors at the new flow instead of
// recreating the candidate files that the migration removed.
console.error(
  [
    "`candidate:new` is retired — the per-surface candidate lane was migrated into",
    "single per-subnet files (registry/subnets/<slug>.json).",
    "",
    "Add a surface to a subnet instead:",
    "  npm run surface:add -- --netuid <n> --kind <kind> \\",
    "    --url <public-url> --source-url <proof-url> \\",
    "    --provider <provider-slug> --submitted-by <github-login> --write",
    "",
    'New subnet with no file yet?  npm run subnet:new -- --netuid <n> --name "<Real Name>" --write',
    "Validate before pushing:        npm run validate:surface -- registry/subnets/<slug>.json",
    "See .claude/skills/contributing-to-metagraphed for the full flow.",
  ].join("\n"),
);
process.exit(1);
