# Resource-contained Node and Electron work

Use this workflow from the first invocation of every Node/Electron renderer test or build process tree. This includes `npm` test/build scripts, `node --test`, Electron tests, Vite builds, JSDOM/React mounted tests, production-bundle harnesses, and scripts that spawn test files or child processes. These commands can retain DOM graphs or multiply child-process memory quickly enough to stall or take down the host before an agent can react.

Run at most one such command at a time across all agents and worktrees.

## Bounded workflow

1. Run the command serially with a short timeout in a transient systemd user scope containing its whole process tree. Apply `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`, and `TasksMax=256`. Include `/usr/bin/time -v` so the result records elapsed time, maximum RSS, swaps, and exit status. A representative wrapper is:

   ```sh
   systemd-run --user --scope \
     -p MemoryHigh=768M -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=256 \
     /usr/bin/time -v timeout --signal=TERM --kill-after=2s 15s \
     node --test --test-concurrency=1 path/to/suspect.test.mjs
   ```

   Adjust the timeout to the known healthy duration without removing or raising the resource limits. Use direct execution or an `exec`-based wrapper so descendants remain in the scope. If the scope or any required property is unavailable, stop and report that blocker rather than substituting a bare or partially bounded run.

2. For mounted React/JSDOM harnesses, retain the created React root and explicitly unmount it. Close every JSDOM window, invoke registered listener disposers, cancel timers or animation frames, and restore or delete globals installed by the test. Add assertions for these cleanup outcomes where practical.

   Keep failure output bounded: compare scalar DOM properties such as text, value, role, name, or an identity boolean. Do not pass whole JSDOM nodes, windows, React roots, or other cyclic object graphs to equality assertions because a mismatch can exhaust memory while the test runner formats the diff.

3. Record the command verdict, elapsed time, maximum RSS, and swap count. Stop and preserve evidence when memory grows continuously toward the 1 GiB hard limit, the scope reports an OOM kill, or the runner stalls; diagnose before another execution.

4. After an isolated test is contained and green, run the complete applicable Node or desktop suite serially under the same limits. Both the isolated test and serial suite must pass within their limits before proceeding to broader, unrelated gates. Every subsequent Node/Electron renderer test or build remains contained, including retries and otherwise unrelated gates.

5. Treat the transient scope as the repository default for this command class. Persistent WSL, swap, or machine-setting changes require explicit user approval and are not a test remediation.

Diagnose within the transient caps. Do not increase available memory or swap, or repeat any affected command unconstrained, in response to a limit failure.
