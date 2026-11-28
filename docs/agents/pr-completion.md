# PR completion

Use this procedure for every implementation PR, including documentation and agent-instruction changes. It applies alongside imported skills without modifying their files. Complete the steps before handing over the PR or marking it ready for review.

## Complete the implementation PR

1. **Audit the final scope.** Read the final diff and originating issues. Inspect affected READMEs, architecture and ownership docs, domain docs, and operational instructions. Search for references that still describe changed behavior as pending or name an outdated owner. Inspect linked follow-up issues and immediate dependent issues for changed scope or dependency status. Completion means every affected document and related ticket is accounted for in the PR evidence, either with an update or a reason no update is needed.

2. **Update documentation in this PR.** Commit behavior, ownership, limitations, and remaining-work updates with the implementation. Describe the behavior delivered by this branch and link follow-up issues for unfinished work. Keep merge status and the eventual merge SHA in GitHub metadata so merging does not require another repository edit. When the audit finds no documentation impact, record that conclusion and its reason.

3. **Reconcile tickets before review.** Follow the [issue tracker conventions](issue-tracker.md). Map acceptance criteria to delivered behavior and validation; check only criteria supported by evidence. Record the PR and tested commit, preserve unmet criteria, and create or update follow-up tickets for remaining work. Update dependent tickets to distinguish a proposed fix from a completed dependency. Normally use PR closing references and leave issues open until merge. A [multi-issue run](multi-issue-runs.md) may close an issue at its tested, pushed integration checkpoint; explicitly identify that checkpoint as integrated into the run branch, with the final PR still awaiting merge. Describe implementation, integration, and merge status accurately in every case.

4. **Review and validate the final change.** Include documentation accuracy, ticket scope, dependency status, and links in the final review. Resolve omissions in this PR. Check Markdown links and whitespace and run checks appropriate to the change. Complete documentation commits before producing required checks and preview artifacts tied to the final PR head. If the head changes, refresh evidence according to the applicable validation and preview requirements.

5. **Record completion evidence in the PR.** Use the existing PR format; add a concise account in its Evidence section of documents updated or checked, tickets reconciled, remaining follow-ups, and verification results. Record current commit and artifact references there. The gate passes when the diff, documentation, tickets, and PR description describe the same delivered scope and no known documentation correction for that scope has been deferred to a later PR.

## After merge

When performing merge closeout, verify the actual merge and resulting issue closure, record the merge SHA and validation links, remove obsolete actionable triage labels from completed issues, and reconsider readiness of dependent issues against all remaining blockers. Preserve separate follow-up issues for unfinished work. This is GitHub status housekeeping; repository documentation should already be complete in the implementation PR. If a missed correction is discovered, fix it and report the omission rather than treating a follow-up documentation PR as the normal workflow.
