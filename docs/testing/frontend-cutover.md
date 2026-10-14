# Frontend cutover verification

This map records the test seams for the portable frontend cutover in #61.
The source of truth for behavior remains the executable tests; this document
identifies why each suite remains after #73.

| Boundary | Evidence |
| --- | --- |
| `DocumentSession` commands, immutable snapshots, subscriptions, semantic attention, structured outcomes, and stale command ordering | `packages/frontend-core/test/document-session.test.ts`, using the deterministic session host and separate journal adapter |
| `WorkingCopy` editing, history, selection, find/replace, baseline, and asynchronous journal ordering | `packages/frontend-core/test/working-copy.test.ts`, using a controlled journal adapter |
| `FocusManager` nested scope, inert chrome, keyboard containment, Escape policy, restoration, and disposal | `packages/react-ui/test/focus-manager.test.ts`, using a deterministic DOM scheduler |
| Production renderer composition | `apps/windows/test/renderer-cutover.test.ts` checks the TypeScript syntax tree for a single `SharedApp` mount and absence of local session authority, duplicate focus state, and raw error handling; mounted bundle tests below verify behavior |
| Production bundle, preload sandbox, IPC projections, and host-only values | `apps/windows/test/desktop-test-gate.desktop.ts`, `electron-boundary.desktop.ts` |
| Nested TypeScript and TSX discovery, execution, and failing-test propagation across platforms | `apps/windows/test/frontend-test-runner.desktop.ts`; the runner passes its loader as a file URL so Windows does not interpret a drive letter as a URL scheme |
| Accessible menus, modal focus, creation form, and independently revealed password pairs | `apps/windows/test/shell-foundation-rendered.desktop.ts`, `creation-security-dialog.desktop.ts`, `security-workflows-rendered.desktop.ts` |
| Lock-start secret clearing and delayed host results | `apps/windows/test/claim-lock-rendered.desktop.ts`, `lock-start-rendered-integration.desktop.ts`, `security-workflows-rendered.desktop.ts` |
| Publication, recovery, replacement, and lifecycle ordering | `apps/windows/test/publication-session-rendered.desktop.ts`, `save-recovery-decisions-rendered.desktop.ts`, `lifecycle-host-ownership-rendered.desktop.ts`, `lifecycle-state-rendered-integration.desktop.ts` |
| Native ABI, Node addon, cross-process host operations, and packaged Windows executable | Fresh CTest build, including the native addon integration targets; `scripts/build-windows-preview.ps1` on a Windows runner for the packaged executable |

The standalone `creation-security-ui.test.mjs` exercised password visibility
without mounting the actual creation dialog, retained a process-global JSDOM,
and duplicated the dialog suite. #73 moved its independent reveal and
draft-preservation assertions into the mounted
`creation-security-dialog.desktop.ts` before deleting it. The other host and
source boundary tests remain because they cover native barriers or preload
constraints that the portable session suite cannot observe.

The Linux gate uses a fresh CMake build with `SCPEFE_BUILD_NODE_ADDON=ON`,
`ctest`, root `npm run typecheck`, root `npm run test:frontend`, and
`npm test --workspace @scpefe/windows`. Every Node/Electron renderer command
runs serially in a complete bounded systemd user scope as described in
`docs/agents/resource-safety.md`. The packaged executable gate is the
`windows-preview.yml` workflow, which runs the PowerShell preview script on
Windows.

All maintained frontend tests and their test-only helpers are TypeScript.
Portable unit and renderer tests use `.test.ts` or `.test.tsx` and run through
`run-frontend-tests.mjs`. Desktop host and mounted production-bundle tests use
`.desktop.ts` and run through `run-desktop-tests.mjs`; both gates use the same
Vite-backed TypeScript loader. The packaged Windows native probes are
`.integration.ts` and receive that loader when launched under Electron's Node
mode. The preview script no longer calls the absent legacy head-witness and
invitation probe files. Converted legacy desktop tests retain their existing
fixture shapes with local `@ts-nocheck` markers; the mounted lifecycle helpers
and the small scenario tests have checked TypeScript contracts.
