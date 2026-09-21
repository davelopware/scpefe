function canceledReplacement() {
  const error = new Error("The current document remains open");
  error.code = "DOCUMENT_REPLACEMENT_CANCELED";
  return error;
}

/* Disposes a staged candidate without changing the authoritative current session. */
export async function disposeReplacement(staged) {
  if (staged?.created) await staged.candidate.abandonCreatedDocument();
  else if (staged?.candidate?.active) await staged.candidate.lock("replacement-canceled");
}

/* Authenticates an Open target in an isolated service while the current session stays live. */
export async function stageOpenReplacement({ makeCandidate, target, password }) {
  const candidate = makeCandidate();
  try {
    await candidate.loadClientSettings();
    const opened = await candidate.openDocument(target, password);
    return Object.freeze({ candidate, opened, target, created: false });
  } catch (error) {
    await disposeReplacement({ candidate, created: false });
    throw error;
  }
}

/* Re-authenticates after interaction and immediately before replacing the session. */
export async function completeOpenReplacement({ staged, authorizeCurrent }) {
  if (!await authorizeCurrent()) {
    await disposeReplacement(staged);
    throw canceledReplacement();
  }
  try {
    await staged.candidate.revalidateTargetForReplacement();
    return staged;
  } catch (error) {
    await disposeReplacement(staged);
    throw error;
  }
}

/* Creates only after authorization and removes exact created bytes on later failure. */
export async function createReplacement({ makeCandidate, target, request,
  authorizeCurrent }) {
  if (!await authorizeCurrent()) throw canceledReplacement();
  const candidate = makeCandidate();
  const staged = { candidate, target, created: true };
  try {
    await candidate.loadClientSettings();
    await candidate.createDocument(target, request);
    await candidate.openDocument(target, request.ownerPassword);
    const opened = await candidate.enterEditMode();
    await candidate.revalidateTargetForReplacement();
    return Object.freeze({ ...staged, opened });
  } catch (error) {
    await disposeReplacement(staged);
    throw error;
  }
}
