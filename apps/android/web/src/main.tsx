import React from "react";
import { createRoot } from "react-dom/client";
import { SharedApp } from "@scpefe/react-ui";
import { CreationSecurityDialog } from "../../../windows/src/creation-security-dialog.tsx";
import { assessProposedPassword, PasswordPolicyStatus,
  proposedPasswordRejectionMessage } from "../../../windows/src/password-policy.ts";
import { RendererLifecycleCompletion } from "../../../windows/src/renderer-lifecycle-completion.ts";
import { catalogText, safeRendererErrorMessage } from "../../../windows/src/error-boundary.mjs";
import { host } from "./bridge.ts";
import "../../../windows/src/styles.css";

declare global { interface Window { scpefe: typeof host } }

window.scpefe = host;
const root = document.getElementById("root");
if (root) createRoot(root).render(<SharedApp sessionHost={host}
  journalTransport={host} events={host} shellHost={host}
  creationTargetHost={host} securityClipboard={host}
  completion={new RendererLifecycleCompletion()}
  catalogText={catalogText} safeRendererErrorMessage={safeRendererErrorMessage}
  closeWindow={() => {}} sourceCommit="Android preview"
  assessProposedPassword={assessProposedPassword}
  proposedPasswordRejectionMessage={proposedPasswordRejectionMessage}
  CreationSecurityDialog={CreationSecurityDialog}
  PasswordPolicyStatus={PasswordPolicyStatus} />);
