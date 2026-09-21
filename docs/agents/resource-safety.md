# Resource-safe Node and renderer testing

Use this workflow only after a Node, renderer, or DOM test OOM; a runner stall; WSL swap or disk thrash; or when adding a harness that mounts a production renderer bundle. Ordinary test changes use the repository's normal commands.

## Bounded workflow

1. Run the suspect test serially with a short timeout in a transient systemd user scope capped at 2 GiB memory and 512 MiB swap. Include `/usr/bin/time -v` so the result records elapsed time, maximum RSS, swaps, and exit status. A representative wrapper is:

   ```sh
   systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=512M \
     /usr/bin/time -v timeout --signal=TERM --kill-after=2s 15s \
     node --test --test-concurrency=1 path/to/suspect.test.mjs
   ```

   Adjust the timeout to the known healthy duration without removing the memory or swap limits. If a systemd user scope is unavailable, stop and report that blocker rather than substituting an unconstrained run.

2. For mounted React/JSDOM harnesses, retain the created React root and explicitly unmount it. Close every JSDOM window, invoke registered listener disposers, cancel timers or animation frames, and restore or delete globals installed by the test. Add assertions for these cleanup outcomes where practical.

3. Record the command verdict, elapsed time, maximum RSS, and swap count. Stop the run and preserve evidence when memory grows continuously into the 1–2 GiB range or swap approaches exhaustion; diagnose before another execution.

4. After the isolated test is bounded and green, run the complete applicable Node or desktop suite serially under the same memory and swap limits. Both the isolated test and serial suite must pass within their limits before proceeding to broader, unrelated gates. Keep the suspect test and affected suite bounded for the remainder of the run.

5. Treat the transient test scope as the repository default for these triggers. Persistent WSL, swap, or machine-setting changes require explicit user approval and are not a test remediation.

Diagnose within the transient caps. Do not increase available memory or swap, or repeat the suspect test or affected full suite unconstrained, as a response to these triggers.
