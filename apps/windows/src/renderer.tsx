import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { SharedApp, type SessionHost, type JournalTransportHost,
  type SessionEventsHost, type ShellHost, type CreationTargetHost,
  type SecurityClipboardHost } from "@scpefe/react-ui";
import { CreationSecurityDialog } from "./creation-security-dialog.tsx";
import { assessProposedPassword, PasswordPolicyStatus,
  proposedPasswordRejectionMessage, type PasswordPolicyHost } from "./password-policy.ts";
import { RENDERER_LIFECYCLE_COMPLETION,
  RendererLifecycleCompletion } from "./renderer-lifecycle-completion.ts";
import { catalogText, safeRendererErrorMessage } from "./error-boundary.mjs";
import "./styles.css";

declare const __SCPEFE_SOURCE_COMMIT__: string;

type WindowsFrontendHost = SessionHost & JournalTransportHost & SessionEventsHost
  & ShellHost & CreationTargetHost & SecurityClipboardHost
  & PasswordPolicyHost & Required<Pick<SessionHost, "createDocument">>;

declare global { interface Window { scpefe: WindowsFrontendHost } }

const completion = new RendererLifecycleCompletion();

/** Composes the Windows host and safe platform adapters with the shared React UI. */
export function mountApp(host: HTMLElement): Root {
  const root = createRoot(host);
  root.render(<SharedApp sessionHost={window.scpefe} journalTransport={window.scpefe}
    events={window.scpefe} shellHost={window.scpefe}
    creationTargetHost={window.scpefe} securityClipboard={window.scpefe}
    completion={completion}
    catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
    closeWindow={() => window.close()}
    sourceCommit={__SCPEFE_SOURCE_COMMIT__}
    assessProposedPassword={assessProposedPassword}
    proposedPasswordRejectionMessage={proposedPasswordRejectionMessage}
    CreationSecurityDialog={CreationSecurityDialog}
    PasswordPolicyStatus={PasswordPolicyStatus} />);
  return root;
}

const applicationHost = document.getElementById("root");
if (applicationHost) {
  (window as unknown as Record<symbol, RendererLifecycleCompletion>)[
    RENDERER_LIFECYCLE_COMPLETION] = completion;
  const applicationRoot = mountApp(applicationHost);
  const mountObserver = (window as unknown as Record<symbol,
    ((root: Root) => void) | undefined>)[Symbol.for("scpefe.renderer.mount")];
  mountObserver?.(applicationRoot);
}
