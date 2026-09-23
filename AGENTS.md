## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. `docs/DOMAIN_MODEL.md` is the canonical glossary. See `docs/agents/domain.md`.

### Resource-contained Node and Electron work

Treat every Node/Electron renderer test or build process tree as host-risky from its first invocation. This includes `npm` test/build scripts, `node --test`, Electron tests, Vite builds, JSDOM/React mounted tests, production-bundle harnesses, and scripts that spawn test files or child processes.

- Before running one, read and follow `docs/agents/resource-safety.md`.
- Run it serially inside a transient systemd user scope that contains the whole process tree, with a timeout, resource measurement, `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`, and `TasksMax=256`.
- Allow at most one such host-risky command at a time across all agents and worktrees. Wait for it to finish before starting another.
- If a systemd user scope or any required limit is unavailable, stop and report the blocker. A bare or partially bounded run is not a fallback.
- Keep every retry and broader follow-up gate contained. A passing isolated test does not authorize an unconstrained suite.

### Actual Electron screenshots

Before capturing UI review evidence, read and follow `docs/agents/ui-screenshots.md`.

## C++ header documentation

- Give every class, struct, enum, function, and method declared in a `.h` or `.hpp` file a succinct purpose comment.
- When modifying a header or its associated `.cpp` file, verify and update the affected declaration comments in the same change.
- Keep one internal class per clearly named `.hpp`/`.cpp` pair. Place C adapters in `_abi.cpp` files.
- Add a cohesive, purpose-named subdirectory when another folder level keeps file counts navigable; avoid generic catch-all folders.

## Single-issue implementation runs

For a ticket implemented with subagents:

1. Assign the issue before changing code.
2. Create one `codex/issue-N` implementer branch in an isolated `/tmp` worktree, based on the intended integration branch or commit.
3. Give one implementation subagent ownership of diagnosis, a tight deterministic feedback loop that reproduces the reported failure, a red regression test before the fix, the fix, focused resource-contained tests, and cohesive commits. If the reported failure cannot be reproduced, stop before hypothesizing or fixing it and report the evidence and required environment or artifact.
4. Give a separate verification subagent the issue criteria and resulting commit. Return findings to the implementer for remediation and repeat independent verification until it passes.
5. Use a separate integration subagent to apply the verified commit to the intended integration branch and run the required integration gate against the exact resulting SHA.
6. Push the tested integration commit and either open its pull request or add it to the parent feature pull request, as appropriate.
7. Close the issue with a comment naming the integrated commit, passing exact-SHA gate, and pull request.
8. Remove the completed issue branch and worktree after successful integration. Preserve failed or incomplete work for diagnosis.
9. Keep all Node/Electron commands globally serial across agents and worktrees, and run every one resource-contained from its first invocation as specified above.

## Multi-issue implementation runs

For a blocker-linked issue range implemented with subagents:

1. Use `codex/dev-sub-agents` as the single integration branch and open one draft PR from it covering the full range.
2. Establish a blocker-first order. Run concurrently only tickets whose blockers are already integrated and verified.
3. Give each issue one implementer branch and isolated `/tmp` worktree based on the latest integration head. Never combine issues in one implementer assignment.
4. After implementation stops, use separate subagents to verify the issue, merge it, and test the resulting integration branch. Keep the orchestrator context to concise reports; inspect implementation details there only to resolve a reported ambiguity or failure.
5. Push the tested integration commit, then close the issue with a comment naming that commit, the passing integration gate, and the draft PR. Treat closed issues as the durable resume checkpoint.
6. Remove completed issue branches and worktrees after integration. Preserve failed or incomplete work for diagnosis instead of merging or closing it.
