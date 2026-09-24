# agent-acceptance

**Check an AI agent's pull request against a contract a human wrote first. It re-runs the tests itself and never takes the agent's word for it.**

Coding agents report success they didn't achieve. One of ours opened a PR saying it had added two tests and that the suite passed with 15. The suite had 15 tests before it started. The two tests were never written. ([The full story](https://blog.stackbilder.com/post/verified-agent-pull-requests-acceptance-gate).)

`agent-acceptance` is the gate we built after that, packaged as a GitHub Action and an npm library. It works with any agent: Claude Code, Codex, Copilot, Cursor, AEGIS, or a person.

## How it works

1. A maintainer writes the contract in the **issue**, before any agent touches it:

   ````markdown
   `slugify('a  b')` returns `a--b`. It should return `a-b`. Add a regression test.

   ```acceptance
   {
     "changed_files_only": ["src/slugify.ts", "tests/slugify.test.ts"],
     "changed_files_required": ["src/slugify.ts", "tests/slugify.test.ts"],
     "max_added_lines": 15,
     "file_contains": [{ "path": "tests/slugify.test.ts", "text": "collapses runs of separators" }],
     "tests": [{ "command": "npx vitest run tests/slugify.test.ts", "passed": 4 }]
   }
   ```
   ````

2. The agent opens a PR that says `Fixes #12`.

3. The Action checks the PR against the contract using only facts it gathers itself:
   - **Scope:** the three-dot diff against the merge base. It fails on files outside `changed_files_only`, on missing `changed_files_required`, and on line counts over the caps.
   - **Content:** it checks required and forbidden strings in the files as they are on the PR head.
   - **Tests:** it re-runs each vitest command with `--reporter=json` writing to a path it picks at check time, then reads the pass count from that report. Test code the agent wrote can print a fake `Tests 99 passed` line. It cannot fake the JSON report at a path that didn't exist when it ran.

4. The result goes to the job summary, and the check fails if any contract item fails.

This is live output from [stackbilt-admin/fork-canary](https://github.com/stackbilt-admin/fork-canary), where [issue #2](https://github.com/stackbilt-admin/fork-canary/issues/2) holds the contract. [PR #3](https://github.com/stackbilt-admin/fork-canary/pull/3) passes. [PR #4](https://github.com/stackbilt-admin/fork-canary/pull/4) makes the same fix plus a README edit, and fails on `changed_files_only — unexpected changes: README.md`.

```text
Acceptance: 6/6 checks passed (re-run by the checker, not reported by the author).

- ✅ changed_files_only — changed: src/slugify.ts, tests/slugify.test.ts
- ✅ changed_files_required — all required files changed
- ✅ max_added_lines — 6 added (limit 15)
- ✅ max_deleted_lines — 1 deleted (limit 3)
- ✅ file_contains — tests/slugify.test.ts contains "collapses runs of separators into one dash"
- ✅ tests — npx vitest run tests/slugify.test.ts: exit 0, 4 passed, 0 failed (expected 4 passed)
```

## Where the contract comes from, and why it matters

**The contract is never read from the PR.** Whoever opens the PR, usually the agent, can edit its description. A contract the agent can edit is the agent grading its own work. So:

- Contracts are read only from issues the PR closes, via GitHub's closing keywords (`Fixes #12`, `Closes #12`, `Resolves #12`).
- The issue's author must be `OWNER`, `MEMBER` or `COLLABORATOR` by default. A contract written by a drive-by account is ignored, and the summary says why.
- An acceptance block in the PR description is ignored, with a note.
- If more than one linked issue carries a contract, the check fails. Link exactly one.

One limit to know: anyone who can edit the issue can edit the contract. If your agent runs with write access to issues, it can rewrite its own contract. Keep the agent's token scoped to contents and pull requests.

## Usage

```yaml
# .github/workflows/agent-acceptance.yml
name: Agent acceptance
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]   # edited: re-check when "Fixes #N" is added

permissions:
  contents: read
  issues: read

jobs:
  acceptance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # the PR head, not the merge commit
          fetch-depth: 0                                  # needed for the merge-base diff
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
      - run: npm ci                                       # or pnpm install --frozen-lockfile
      - uses: Stackbilt-dev/agent-acceptance@v0
        with:
          require-contract: 'false'                       # 'true' fails PRs that close no contracted issue
```

Use `on: pull_request`, **not** `pull_request_target`. The Action runs the PR's tests, and `pull_request_target` would give that code write access to your repository. With `pull_request`, the token is read-only and fork PRs get no secrets, which is all the Action needs.

### Inputs

| Input | Default | |
|---|---|---|
| `require-contract` | `false` | Fail PRs that close no issue with a trusted contract. Turn it on for agent-authored PRs, e.g. in a workflow filtered by label or author. |
| `trusted-associations` | `OWNER,MEMBER,COLLABORATOR` | Issue author associations whose contracts are honored. |
| `github-token` | `github.token` | Used only to read the linked issue. |
| `working-directory` | workspace | The checkout to inspect. |

Output: `status` is `passed`, `failed` or `unchecked`.

## Contract reference

| Key | Checks |
|---|---|
| `changed_files_only` | Every changed file is in this list. |
| `changed_files_required` | Every file in this list changed. |
| `max_added_lines` / `max_deleted_lines` | Total lines added or deleted across the diff are at most N. |
| `file_contains` / `file_excludes` | `[{ "path", "text" }]`: the file on the PR head contains, or doesn't contain, the text. |
| `tests` | `[{ "command", "passed", "cwd"? }]`: the command exits 0, and vitest's JSON report shows exactly `passed` passing tests and no failures. |

Test commands must be `pnpm exec vitest run …`, `npx vitest run …` or `yarn vitest run …`, with no shell syntax. They run without a shell. `cwd` is a repository-relative directory, for monorepos. The format is the same one the [AEGIS](https://aegis.stackbilt.dev) sandbox executor uses, so a contract works in both.

## Library

```ts
import { parseAcceptanceSpec, evaluateAcceptance, checkoutFacts, formatAcceptanceReport } from '@stackbilt/agent-acceptance';

const parsed = parseAcceptanceSpec(issueBody);
if (parsed.kind === 'spec') {
  const verdict = await evaluateAcceptance(parsed.spec, checkoutFacts({ root: '.', base: 'origin/main', head: 'HEAD' }));
  console.log(formatAcceptanceReport(verdict));
}
```

`evaluateAcceptance` takes any `AcceptanceFacts` implementation, so you can supply facts from a sandbox, a container or a remote runner.

## What it doesn't do

- It doesn't judge whether the tests are *good*. It proves scope, content and test counts, so a reviewer starts from verified facts instead of the agent's summary. Review is still review.
- vitest is the only test runner for now.
- PRs opened from forks: in our first test, a PR from a fork in another organization did not trigger `pull_request` workflows at all ([fork-canary#1](https://github.com/stackbilt-admin/fork-canary/pull/1)). Same-repository PRs work. We are investigating.

## License

Apache-2.0 · Built by [Stackbilt](https://stackbilder.com). Want this run on your repo by our agent? [Verified Agent Pilot](https://stackbilder.com/verified-agent-pilot).
