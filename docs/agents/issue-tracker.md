# Issue tracker: GitHub

Issues and specifications for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body "..."`.
- **Read an issue:** `gh issue view <number> --comments`, including its labels.
- **List issues:** use `gh issue list` with the appropriate state and label filters.
- **Comment:** `gh issue comment <number> --body "..."`.
- **Apply or remove labels:** use `gh issue edit` with `--add-label` or `--remove-label`.
- **Close:** `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. If a bare reference is ambiguous, try `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, run `gh issue view <number> --comments`.

Create dependent tickets in blocker-first order. Represent blocking edges with GitHub's native issue dependencies where available. Otherwise, add a `Blocked by: #<number>` line to the dependent issue. A ticket is ready only when all its blockers are closed.

Apply the `ready-for-agent` label to agent-ready implementation tickets.

For wayfinding work, use a single issue labelled `wayfinder:map` as the map and link child issues as GitHub sub-issues where available. Label children by type (`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`). Claim work by assigning the issue before making changes.
