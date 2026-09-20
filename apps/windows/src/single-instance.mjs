import path from "node:path";

/* Extracts one Windows shell-open target while rejecting switches and other file types. */
export function openTargetFromCommandLine(commandLine, workingDirectory = process.cwd()) {
  if (!Array.isArray(commandLine)) return null;
  for (const argument of commandLine.slice(1)) {
    if (typeof argument !== "string" || !argument
        || argument.startsWith("-") || !/\.scpefe$/i.test(argument)) continue;
    return path.resolve(workingDirectory, argument);
  }
  return null;
}

/* Accepts only a validated shell-open target from untrusted second-instance metadata. */
export function openTargetFromAdditionalData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.openTarget !== "string"
      || !path.isAbsolute(value.openTarget)
      || !/\.scpefe$/i.test(value.openTarget)) return null;
  return path.normalize(value.openTarget);
}

/* Validates the random acknowledgement token used only for liveness signalling. */
export function acknowledgementToken(value) {
  const token = value?.acknowledgementToken;
  return typeof token === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(token) ? token : null;
}
