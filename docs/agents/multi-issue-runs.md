# Multi-issue implementation runs

Use this runbook for a run that implements more than one GitHub issue. The coordinator keeps the sequence and checkpoints and delegates implementation, verification, publication, preview, and closeout. Use a fresh subagent for each stage, with only one subagent active at a time.

## Start the run

1. Read each issue and its blockers, then order the issues blocker first. Start only an issue whose blockers are integrated and verified.
2. Create `codex/dev-sub-agents` as the single integration branch, push it, and open one draft PR covering the run. Record the issue order and update the PR body as checkpoints land.
3. For each issue, create a distinct branch and isolated `/tmp` worktree from the latest **tested and pushed** integration commit. Assign only that issue to its implementer.

Each handoff names the issue number, branch and commit SHA, integration SHA, current checkpoint, draft PR, and the prior stage's concise result and gate evidence. The coordinator handles handoffs and status; inspect implementation details only when resolving a reported ambiguity or failure.

## Complete one issue before the next

| Stage | Fresh agent's task | Completion gate |
| --- | --- | --- |
| Implement | Make and commit the issue's change on its own branch and worktree. | Commit SHA and focused verification result are recorded. |
| Verify | Independently check the issue specification and repository rules against that commit; run relevant checks. | Explicit pass with commands and results, or a concrete failure report. |
| Merge | Integrate the verified issue commit into `codex/dev-sub-agents`. | Integration SHA identifies the issue's committed work; conflicts are resolved and reviewed. |
| Integration test | Run the complete applicable gate on the resulting integration SHA. | Passing commands, results, and resource measurements are recorded. |
| Publish | Push that tested integration SHA, update the draft PR checkpoint, and close the issue with a comment naming the integration SHA, passing gate, and PR. | Remote SHA matches the tested SHA and the issue is closed. |

Read and follow [resource safety](resource-safety.md) before every Node/Electron renderer test or build, including focused tests, retries, integration gates, and preview builds run locally. Run at most one such process tree across agents and worktrees. Use the [issue tracker conventions](issue-tracker.md) for issue operations.

After publication, remove the completed issue branch and worktree. Preserve branches, worktrees, and failure evidence for incomplete issues. Re-engage an agent only to correct failed tests in its own task; use a fresh agent for other follow-up work. If a gate fails, repair and rerun it before publishing, closing the issue, or starting the next issue. Leave an issue branch unmerged when verification fails.

## Finish the PR

1. Assign a fresh agent to finish the PR. Keep its body reviewable: list covered issues, each issue's commit and closed checkpoint, the final integration gate, and the preview link. Confirm the final PR head is the tested integration SHA.
2. Run the validated path of `.github/workflows/windows-preview.yml` at that **exact final PR SHA** with tests enabled. Verify the workflow's head SHA, successful test/build/package steps, and downloadable unsigned Windows ZIP. Record the artifact link and expiry in the PR. A preview produced with `skip_tests=true` does not meet this gate.
3. Mark the draft PR ready for review only after the validated artifact is available at the final SHA. If the PR head changes, rerun the integration gate and preview for the new SHA.

## Close out after merge

Assign a fresh agent to verify the PR merged and every covered issue is closed with its tested commit and gate recorded. Preserve the preview link and its download window for reviewers. Remove only merged run branches and worktrees after checking for uncommitted or unrelated work. Recheck dependent issues now unblocked by the merge and apply the repository's triage labels where appropriate.
