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
| Production bundle, preload sandbox, IPC projections, and host-only values | `apps/windows/test/desktop-test-gate.test.mjs`, `electron-boundary.test.mjs` |
| Accessible menus, modal focus, creation form, and independently revealed password pairs | `apps/windows/test/shell-foundation-rendered.test.mjs`, `creation-security-dialog.test.mjs`, `security-workflows-rendered.test.mjs` |
| Lock-start secret clearing and delayed host results | `apps/windows/test/claim-lock-rendered.test.mjs`, `lock-start-rendered-integration.test.mjs`, `security-workflows-rendered.test.mjs` |
| Publication, recovery, replacement, and lifecycle ordering | `apps/windows/test/publication-session-rendered.test.mjs`, `save-recovery-decisions-rendered.test.mjs`, `lifecycle-host-ownership-rendered.test.mjs`, `lifecycle-state-rendered-integration.test.mjs` |
| Native ABI, Node addon, cross-process host operations, and packaged Windows executable | Fresh CTest build, including the native addon integration targets; `scripts/build-windows-preview.ps1` on a Windows runner for the packaged executable |

The standalone `creation-security-ui.test.mjs` exercised password visibility
without mounting the actual creation dialog, retained a process-global JSDOM,
and duplicated the dialog suite. #73 moved its independent reveal and
draft-preservation assertions into the mounted
`creation-security-dialog.test.mjs` before deleting it. The other host and
source boundary tests remain because they cover native barriers or preload
constraints that the portable session suite cannot observe.

The Linux gate uses a fresh CMake build with `SCPEFE_BUILD_NODE_ADDON=ON`,
`ctest`, root `npm run typecheck`, root `npm run test:frontend`, and
`npm test --workspace @scpefe/windows`. Every Node/Electron renderer command
runs serially in a complete bounded systemd user scope as described in
`docs/agents/resource-safety.md`. The packaged executable gate is the
`windows-preview.yml` workflow, which runs the PowerShell preview script on
Windows.
