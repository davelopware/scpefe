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

## C++ header documentation

- Give every class, struct, enum, function, and method declared in a `.h` or `.hpp` file a succinct purpose comment.
- When modifying a header or its associated `.cpp` file, verify and update the affected declaration comments in the same change.
- Keep one internal class per clearly named `.hpp`/`.cpp` pair. Place C adapters in `_abi.cpp` files.
- Add a cohesive, purpose-named subdirectory when another folder level keeps file counts navigable; avoid generic catch-all folders.

## Multi-issue implementation runs

For a blocker-linked issue range implemented with subagents:

1. Use `codex/dev-sub-agents` as the single integration branch and open one draft PR from it covering the full range.
2. Establish a blocker-first order. Run concurrently only tickets whose blockers are already integrated and verified.
3. Give each issue one implementer branch and isolated `/tmp` worktree based on the latest integration head. Never combine issues in one implementer assignment.
4. After implementation stops, use separate subagents to verify the issue, merge it, and test the resulting integration branch. Keep the orchestrator context to concise reports; inspect implementation details there only to resolve a reported ambiguity or failure.
5. Push the tested integration commit, then close the issue with a comment naming that commit, the passing integration gate, and the draft PR. Treat closed issues as the durable resume checkpoint.
6. Remove completed issue branches and worktrees after integration. Preserve failed or incomplete work for diagnosis instead of merging or closing it.
