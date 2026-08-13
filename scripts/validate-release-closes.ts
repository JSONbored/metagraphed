// Stops a release PR from closing an issue nobody finished (#11052).
//
// release-please carries the generated changelog as the release PR's BODY, and
// GitHub honours closing keywords anywhere in a PR body -- including inside
// <details>. The changelog generator emits `closes #N` for any issue reference
// it extracts from a commit, and it does not distinguish a deliberate
// `Refs #N`. So a PR that said `Refs #10606` because the work was partial comes
// back a week later as `closes #10606` in a release PR, and merging the release
// closes the issue.
//
// Measured on #11050: its body claimed to close 46 issues. 45 were already
// closed by their own PRs (harmless noise); exactly one -- #10606 -- was open,
// deliberately, because its third ask has no implementation. Editing the body by
// hand does not survive: release-please regenerates it on every run.
//
// So the check is on the BODY, not on CHANGELOG.md: a closing keyword in a
// committed file has no effect, only a PR body does. And it deliberately does
// NOT lint the changelog text -- the issue links are the only trail from a
// released version back to why a change happened, and they should stay. The one
// case with a side effect is the one this fails on.
//
// The remedy when it fires is either to finish the issue or to rewrite that one
// keyword to `refs`, and both are decisions a person should make on purpose.
//
// Takes a PR NUMBER and fetches the body itself, rather than having the workflow
// interpolate `${{ github.event.pull_request.body }}`. A PR body is
// attacker-controllable text, and passing it through the workflow -- even via
// `env:` -- means untrusted text crosses that boundary at all. A number does
// not. scripts/validate-workflows.ts refuses the interpolation outright, which
// is the right call and pushed this to the better design.
//
// Runnable by hand against any PR:  node scripts/validate-release-closes.ts 11050
import { execFileSync } from "node:child_process";

/** GitHub's closing keywords, verbatim from its own docs. Case-insensitive. */
const CLOSING_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
] as const;

// Matches `closes #123`, and the markdown-linked form release-please actually
// emits (`closes [#123](https://github.com/owner/repo/issues/123)`). The
// optional `[` before `#` is what makes the linked form parse; without it the
// generated changelog reads as having no closing keywords at all, which is the
// silent-pass this gate exists to prevent.
const SAME_REPO = new RegExp(
  String.raw`\b(${CLOSING_KEYWORDS.join("|")})\b\s*:?\s*\[?#(\d+)`,
  "gi",
);

// `owner/repo#123` and full issue URLs. Captured separately because a
// cross-repo closing keyword does NOT close anything in the other repo -- only
// a reference in ITS OWN repo does -- so counting them here would fail the
// release for an issue the merge cannot touch.
const CROSS_REPO = new RegExp(
  String.raw`\b(?:${CLOSING_KEYWORDS.join("|")})\b\s*:?\s*\[?(?:[\w.-]+/[\w.-]+#\d+|https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+)`,
  "gi",
);

export interface ParsedClosers {
  /** Issue numbers this body would close in THIS repo, ascending, deduped. */
  sameRepo: number[];
  /** How many closing keywords named another repo, which cannot close here. */
  crossRepoCount: number;
}

/**
 * Parse the closing keywords out of a PR body.
 *
 * PURE, so the parsing rules are testable without the network or a PR. Strips
 * fenced code blocks first: a changelog that quotes a commit message inside
 * ``` is showing text, not asking GitHub to close anything -- and GitHub agrees,
 * it ignores keywords in code fences.
 */
export function parseClosingKeywords(body: string): ParsedClosers {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  const sameRepo = new Set<number>();
  for (const match of withoutFences.matchAll(SAME_REPO)) {
    const issue = Number(match[2]);
    if (Number.isInteger(issue) && issue > 0) sameRepo.add(issue);
  }
  const crossRepoCount = [...withoutFences.matchAll(CROSS_REPO)].length;
  return {
    sameRepo: [...sameRepo].sort((a, b) => a - b),
    crossRepoCount,
  };
}

export interface IssueState {
  number: number;
  state: string;
  title: string;
}

/** Format the failure so the operator can act without opening every link. */
export function formatOpenIssues(open: readonly IssueState[]): string {
  return [
    `This release PR's body would CLOSE ${open.length} issue(s) that are still open:`,
    "",
    ...open.map((i) => `  #${i.number}  ${i.title}`),
    "",
    "release-please emits `closes #N` for every issue a commit referenced,",
    "including a deliberate `Refs #N`. Merging this PR would close the above.",
    "",
    "Fix it by either:",
    "  - finishing the issue, so closing it is correct; or",
    "  - editing that one keyword to `refs` in the commit that introduced it,",
    "    so the regenerated body stops claiming it.",
    "",
    "Editing this PR's body by hand does not hold -- release-please rewrites it.",
  ].join("\n");
}

function issueStates(numbers: readonly number[], repo: string): IssueState[] {
  const states: IssueState[] = [];
  for (const number of numbers) {
    // One call per issue rather than a search query: a search index can lag a
    // just-closed issue by minutes, and a stale OPEN here would fail a release
    // for no reason.
    const raw = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/issues/${number}`,
        "--jq",
        "{number:.number,state:.state,title:.title,pull:(.pull_request!=null)}",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(raw) as IssueState & { pull: boolean };
    // A PR is an issue to the REST API. A closing keyword naming a PR does not
    // leave an issue unfinished, so it is not this gate's business.
    if (parsed.pull) continue;
    states.push({
      number: parsed.number,
      state: parsed.state,
      title: parsed.title,
    });
  }
  return states;
}

/** Fetch one PR's body. Separated so `main` stays a readable sequence. */
function prBody(number: number, repo: string): string {
  return execFileSync(
    "gh",
    ["api", `repos/${repo}/pulls/${number}`, "--jq", '.body // ""'],
    { encoding: "utf8" },
  );
}

function main(): void {
  const arg = process.argv[2];
  const number = Number(arg);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!arg || !Number.isInteger(number) || number <= 0) {
    // Named, not defaulted: a check that "passes" having examined no PR has
    // checked nothing, which is the failure mode this gate exists to prevent
    // one level up.
    console.error(
      `needs a pull-request number; got ${JSON.stringify(arg ?? "")}\n` +
        "  node scripts/validate-release-closes.ts <pr-number>",
    );
    process.exit(1);
  }
  if (!repo) {
    console.error("GITHUB_REPOSITORY is not set");
    process.exit(1);
  }
  const body = prBody(number, repo);

  const { sameRepo, crossRepoCount } = parseClosingKeywords(body);
  if (sameRepo.length === 0) {
    console.log(
      "No same-repo closing keywords in the release PR body" +
        (crossRepoCount > 0
          ? ` (${crossRepoCount} cross-repo one(s) ignored — they cannot close here).`
          : "."),
    );
    return;
  }

  const states = issueStates(sameRepo, repo);
  const open = states.filter((i) => i.state.toUpperCase() === "OPEN");
  if (open.length > 0) {
    console.error(formatOpenIssues(open));
    process.exit(1);
  }
  console.log(
    `Release PR body closes ${states.length} issue(s), all already closed` +
      (crossRepoCount > 0
        ? `; ${crossRepoCount} cross-repo reference(s) ignored.`
        : "."),
  );
}

// Only when run directly, so the pure helpers stay importable by tests.
if (process.argv[1]?.endsWith("validate-release-closes.ts")) {
  main();
}
