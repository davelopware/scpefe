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

## Multi-issue implementation runs

For any run implementing multiple GitHub issues, follow `docs/agents/multi-issue-runs.md`:

1. Use `codex/dev-sub-agents` as the single integration branch and open one draft PR for the run. Work through issues in blocker-first order, one issue at a time, with only one active subagent.
2. Give each issue its own branch and isolated `/tmp` worktree based on the latest tested, pushed integration commit. Use a fresh subagent for each stage: implement, independently verify, merge, integration test, and publish. Reuse an agent only to correct failed tests in its own task.
3. Keep the coordinator to bounded handoffs and status. Inspect implementation details only to resolve a reported ambiguity or failure.
4. Finish each issue's committed, verified, merged, integration-tested, pushed, and closed checkpoint before starting the next. Preserve incomplete work for diagnosis.
5. Before marking the PR ready for review, provide a validated downloadable Windows preview built from the exact final PR commit. After merge, verify issue closure and clean up merged branches and worktrees while preserving the preview.
