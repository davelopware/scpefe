## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. `docs/DOMAIN_MODEL.md` is the canonical glossary. See `docs/agents/domain.md`.

## C++ header documentation

- Give every class, struct, enum, function, and method declared in a `.h` or `.hpp` file a succinct purpose comment.
- When modifying a header or its associated `.cpp` file, verify and update the affected declaration comments in the same change.
- Keep one internal class per clearly named `.hpp`/`.cpp` pair. Place C adapters in `_abi.cpp` files.
- Add a cohesive, purpose-named subdirectory when another folder level keeps file counts navigable; avoid generic catch-all folders.
