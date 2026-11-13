/* A host-owned target is identified by a stable opaque string, never parsed as a path. */
export function validateOpaqueTarget(target) {
  if (typeof target !== "string" || !target || target.includes("\0")) {
    throw new TypeError("invalid opaque document target");
  }
  return target;
}

/* Declares the behavior required by the document workflow, independent of provider metadata. */
export function validateTargetCapabilities(capabilities) {
  if (!capabilities || capabilities.readReread !== true
      || capabilities.exactCandidatePublication !== true
      || capabilities.exactByteVerification !== true
      || capabilities.outcomes !== true) {
    throw new TypeError("host target lacks required document capabilities");
  }
  return Object.freeze({ readReread: true, exactCandidatePublication: true,
    exactByteVerification: true, outcomes: true });
}

/* Reads a target without interpreting its identity or provider revision metadata. */
export async function readDocumentTarget(host, target) {
  validateOpaqueTarget(target);
  const bytes = await host.read(target);
  if (!Buffer.isBuffer(bytes)) throw new TypeError("host target read must return bytes");
  return bytes;
}

/* Classifies the observed bytes against a prepared base and exact candidate. */
export function classifyTargetImage(observed, base, candidate) {
  if (observed === null) return "unavailable";
  if (!Buffer.isBuffer(observed)) throw new TypeError("invalid observed target bytes");
  if (observed.equals(candidate)) return "verified";
  if (observed.equals(base)) return "unchanged";
  return "changed";
}
