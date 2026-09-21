import { validateCreateFormRequest, validateCreateRequest } from "./contracts.mjs";

/* Validates secrets before choosing a target and invoking native-backed creation. */
export async function createDocumentWithTarget(request, chooseTarget, createDocument) {
  const validated = validateCreateFormRequest(request);
  const target = await chooseTarget();
  if (target === null) return null;
  return createDocument(target, validateCreateRequest(validated));
}
