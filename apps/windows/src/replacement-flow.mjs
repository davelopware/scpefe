async function discardCandidate(candidate) {
  if (candidate?.active) await candidate.lock("replacement-failed");
}

function canceledReplacement() {
  const error = new Error("The current document remains open");
  error.code = "DOCUMENT_REPLACEMENT_CANCELED";
  return error;
}

/* Opens a candidate session completely before allowing the current session to switch. */
export async function openReplacement({ makeCandidate, target, password,
  commitCurrent }) {
  const candidate = makeCandidate();
  try {
    await candidate.loadClientSettings();
    const opened = await candidate.openDocument(target, password);
    if (!await commitCurrent()) {
      await discardCandidate(candidate);
      throw canceledReplacement();
    }
    return Object.freeze({ candidate, opened });
  } catch (error) {
    await discardCandidate(candidate);
    throw error;
  }
}

/* Creates and enters edit mode on a blank candidate before switching sessions. */
export async function createReplacement({ makeCandidate, target, request,
  commitCurrent }) {
  const candidate = makeCandidate();
  try {
    await candidate.loadClientSettings();
    await candidate.createDocument(target, request);
    await candidate.openDocument(target, request.ownerPassword);
    const opened = await candidate.enterEditMode();
    if (!await commitCurrent()) {
      await discardCandidate(candidate);
      throw canceledReplacement();
    }
    return Object.freeze({ candidate, opened });
  } catch (error) {
    await discardCandidate(candidate);
    throw error;
  }
}
