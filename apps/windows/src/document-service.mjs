import path from "node:path";
import { canonicalizeDocumentText, validateCreateRequest, validateEditMode,
  validateOpenedDocument, validatePassword, validateProfile,
  validatePlaintextExportRequest, validatePlaintextExportResult,
  validateSaveResult } from "./contracts.mjs";

export class DocumentService {
  constructor({ native, fs, profilePath,
    nativeLineEnding = process.platform === "win32" ? "\r\n" : "\n" }) {
    this.native = native;
    this.fs = fs;
    this.profilePath = profilePath;
    this.nativeLineEnding = nativeLineEnding;
    this.active = null;
  }

  async loadProfile() {
    try {
      return validateProfile(JSON.parse(await this.fs.readFile(this.profilePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveProfile(profile) {
    const validated = validateProfile(profile);
    await this.fs.mkdir(path.dirname(this.profilePath), { recursive: true });
    await this.#atomicWrite(this.profilePath,
      Buffer.from(`${JSON.stringify(validated)}\n`, "utf8"), true);
    return validated;
  }

  async createDocument(target, request) {
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const input = validateCreateRequest(request);
    const candidate = this.native.createDocument({
      ...profile,
      ...input,
      timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    await this.#atomicWrite(target, candidate, false);
    const published = await this.fs.readFile(target);
    if (!published.equals(candidate)) throw new Error("Published container verification failed");
    return { created: true };
  }

  async openDocument(target, password) {
    const bytes = await this.fs.readFile(target);
    const validatedPassword = validatePassword(password);
    const opened = validateOpenedDocument(
      this.native.openDocument(bytes, validatedPassword));
    this.active = { target, password: validatedPassword, opened, editMode: false };
    return opened;
  }

  enterEditMode() {
    if (!this.active) throw new Error("Open a document first");
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    this.active.editMode = true;
    return validateEditMode({ ...this.active.opened, readOnly: false });
  }

  async saveDocument(content) {
    if (!this.active) throw new Error("Open a document first");
    if (!this.active.editMode) throw new Error("Enter edit mode before saving");
    if (!this.active.opened.canEdit) {
      throw new Error("The active password slot does not permit editing");
    }
    const profile = await this.loadProfile();
    if (!profile) throw new Error("Configure name, email, and device name first");
    const canonical = canonicalizeDocumentText(content);
    const current = await this.fs.readFile(this.active.target);
    const candidate = this.native.saveDocument(current, this.active.password, {
      ...profile, content: canonical, timestampMs: Date.now(),
    });
    if (!Buffer.isBuffer(candidate) || candidate.length === 0) {
      throw new Error("Native bridge did not produce a container");
    }
    await this.#atomicWrite(this.active.target, candidate, true);
    const published = await this.fs.readFile(this.active.target);
    if (!published.equals(candidate)) throw new Error("Published container verification failed");
    const reopened = validateOpenedDocument(
      this.native.openDocument(published, this.active.password));
    if (reopened.content !== canonical) throw new Error("Saved document verification failed");
    this.active.opened = reopened;
    return validateSaveResult({ saved: true, content: canonical });
  }

  async exportPlaintext(target, request) {
    if (!this.active) throw new Error("Open a document first");
    const validated = validatePlaintextExportRequest(request);
    const content = validated.lineEndings === "native"
      ? validated.content.replace(/\n/g, this.nativeLineEnding)
      : validated.content;
    await this.fs.writeFile(target, Buffer.from(content, "utf8"));
    return validatePlaintextExportResult({ exported: true });
  }

  async #atomicWrite(target, bytes, replace) {
    const transaction = `${target}.scpefe-txn-${process.pid}-${Date.now()}`;
    let handle;
    try {
      handle = await this.fs.open(transaction, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      if (replace) {
        await this.fs.rename(transaction, target);
      } else {
        await this.fs.link(transaction, target);
        await this.fs.unlink(transaction);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(transaction).catch(() => {});
      throw error;
    }
  }
}
