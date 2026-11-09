package org.scpefe.nativecore;

import android.content.Context;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONException;
import org.json.JSONObject;

/** Serial-worker owner of one native document and opaque Android target. */
public final class AndroidSessionController {
    /** Safe error code and message returned across the WebView boundary. */
    public static final class Failure extends Exception {
        public final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }

    private static final int MAX_WEB_TEXT = 1024 * 1024;
    private final AndroidDocumentTargets targets;
    private final AndroidProfileSettings profiles;
    private final AndroidWorkJournals journals;
    private final AtomicLong generation = new AtomicLong();
    private String selectedTarget;
    private String activeTarget;
    private byte[] activeEncrypted;
    private long nativeHandle;

    /** Uses the Android target and private profile adapters as the only host state. */
    public AndroidSessionController(Context context) {
        targets = new AndroidDocumentTargets(context);
        profiles = new AndroidProfileSettings(context);
        journals = new AndroidWorkJournals(context);
    }

    /** Invalidates queued work before a picker, close, or replacement starts. */
    public long replaceGeneration() { return generation.incrementAndGet(); }

    /** Captures the current document generation for one asynchronous operation. */
    public long generation() { return generation.get(); }

    /** Rejects a result whose document was closed or replaced while core work ran. */
    public void requireCurrent(long expected) throws Failure {
        if (generation.get() != expected) throw new Failure("STALE_OPERATION",
            "The document changed while this operation was running.");
    }

    /** Retains the picked document only in app-private target metadata. */
    public void selected(String target) throws Failure {
        if (!targets.owns(target)) throw new Failure("TARGET_INVALID", "Selected document is unavailable.");
        selectedTarget = target;
    }

    /** Forgets a canceled picker choice without disturbing the active document. */
    public void clearSelection() { selectedTarget = null; }

    /** Returns the authoritative provider picker adapter. */
    public AndroidDocumentTargets targets() { return targets; }

    /** Loads the validated private client profile. */
    public JSONObject profile() throws IOException { return profiles.loadProfile(); }

    /** Persists only validated profile fields. */
    public JSONObject saveProfile(JSONObject value) throws IOException {
        return profiles.saveProfile(value);
    }

    /** Loads validated client settings. */
    public JSONObject settings() throws IOException { return profiles.loadSettings(); }

    /** Persists validated client settings. */
    public JSONObject saveSettings(JSONObject value) throws IOException {
        return profiles.saveSettings(value);
    }

    /** Reports app-private records that still require a recovery decision. */
    public int unresolvedJournalCount() { return journals.unresolvedCount(); }

    /** Applies core password policy to bounded UTF-8 without retaining the bytes. */
    public String assessPassword(String password) throws Failure {
        byte[] bytes = secret(password);
        try {
            switch (NativeCore.nativeAssessPassword(bytes)) {
                case 1: return "accepted";
                case 2: return "minimum-length";
                case 3: return "predictable";
                default: return "invalid";
            }
        } finally { Arrays.fill(bytes, (byte)0); }
    }

    /** Creates a revised-v3 image and publishes only after exact provider reread. */
    public JSONObject create(JSONObject request, long expected) throws Failure {
        requireCurrent(expected);
        if (selectedTarget == null) throw new Failure("TARGET_MISSING", "Choose a document first.");
        String target = selectedTarget;
        JSONObject profile;
        try { profile = profiles.loadProfile(); }
        catch (IOException error) { throw new Failure("PROFILE_UNAVAILABLE", "Profile unavailable."); }
        if (profile == null) throw new Failure("PROFILE_REQUIRED", "Configure a profile first.");
        String owner = text(request, "ownerPassword", 4096, false);
        String confirmation = text(request, "ownerPasswordConfirmation", 4096, false);
        String recovery = text(request, "recoveryPassword", 4096, true);
        String recoveryConfirmation = text(request, "recoveryPasswordConfirmation", 4096, true);
        if (!owner.equals(confirmation) || !recovery.equals(recoveryConfirmation)
                || (!recovery.isEmpty() && owner.equals(recovery))
                || !request.optBoolean("understandsIrrecoverable")
                || (!recovery.isEmpty() && !request.optBoolean("storedRecoverySeparately"))) {
            throw new Failure("CREATE_INVALID", "Creation details are invalid.");
        }
        String content = text(request, "content", 16, true);
        String type = request.optString("contentType", "plain-text");
        if (!("plain-text".equals(type) && content.isEmpty())
                && !("csv".equals(type) && "\"\"".equals(content))) {
            throw new Failure("CREATE_INVALID", "Creation content is invalid.");
        }
        byte[] ownerBytes = secret(owner), recoveryBytes = recovery.isEmpty()
            ? null : secret(recovery);
        byte[] contentBytes = content.getBytes(StandardCharsets.UTF_8);
        try {
            closeNow();
            requireCurrent(expected);
            openContext();
            NativeCore.Result created = NativeCore.nativeCreateDocument(nativeHandle,
                profile.optString("name").getBytes(StandardCharsets.UTF_8),
                profile.optString("email").getBytes(StandardCharsets.UTF_8),
                profile.optString("deviceName").getBytes(StandardCharsets.UTF_8),
                contentBytes, System.currentTimeMillis(), ownerBytes, recoveryBytes,
                "csv".equals(type) ? 1 : 0);
            check(created.status);
            requireCurrent(expected);
            NativeCore.Result encrypted = NativeCore.nativeCopyEncrypted(nativeHandle);
            check(encrypted.status);
            try {
                requireCurrent(expected);
                NativeCore.Result read = NativeCore.nativeRead(nativeHandle);
                check(read.status);
                NativeCore.Result key = NativeCore.nativeJournalKey(nativeHandle);
                check(key.status);
                String documentId = hex(read.documentId);
                try {
                    journals.writePendingCreate(documentId, target, key.data,
                        encrypted.data, content);
                } catch (IOException error) {
                    throw new Failure("PRIVATE_STATE_UNAVAILABLE",
                        "Could not preserve the encrypted document candidate.");
                } finally {
                    if (read.data != null) Arrays.fill(read.data, (byte)0);
                    if (key.data != null) Arrays.fill(key.data, (byte)0);
                }
                if (targets.create(target, encrypted.data) != TargetPublication.Outcome.VERIFIED) {
                    throw new Failure("PUBLICATION_AMBIGUOUS",
                        "The selected document could not be verified after writing.");
                }
                activeEncrypted = encrypted.data.clone();
                try { journals.clear(documentId); }
                catch (IOException error) {
                    throw new Failure("PRIVATE_STATE_UNAVAILABLE",
                        "Document was verified, but local recovery state could not be cleared.");
                }
            } finally { Arrays.fill(encrypted.data, (byte)0); }
            activeTarget = target;
            selectedTarget = null;
            requireCurrent(expected);
            return opened();
        } catch (Failure error) {
            closeNow();
            throw error;
        } finally {
            Arrays.fill(ownerBytes, (byte)0);
            if (recoveryBytes != null) Arrays.fill(recoveryBytes, (byte)0);
            Arrays.fill(contentBytes, (byte)0);
            if (generation.get() != expected) closeNow();
        }
    }

    /** Reads the selected provider image, then authenticates through the native core. */
    public JSONObject open(String password, long expected) throws Failure {
        requireCurrent(expected);
        if (selectedTarget == null) throw new Failure("TARGET_MISSING", "Choose a document first.");
        String target = selectedTarget;
        byte[] bytes;
        try { bytes = targets.read(target); }
        catch (IOException error) { throw new Failure("TARGET_UNAVAILABLE", "Selected document is unavailable."); }
        requireCurrent(expected);
        closeNow();
        openContext();
        try {
            check(NativeCore.nativeOpen(nativeHandle, bytes).status);
            requireCurrent(expected);
            unlockBytes(password);
            requireCurrent(expected);
            activeTarget = target;
            activeEncrypted = bytes.clone();
            selectedTarget = null;
            requireCurrent(expected);
            return opened();
        } catch (Failure error) {
            closeNow();
            throw error;
        } finally { Arrays.fill(bytes, (byte)0); }
    }

    /** Reopens the retained encrypted image for a locked document. */
    public JSONObject unlock(String password, long expected) throws Failure {
        requireCurrent(expected);
        if (activeEncrypted == null) throw new Failure("INVALID_STATE", "No locked document.");
        closeNative();
        openContext();
        check(NativeCore.nativeOpen(nativeHandle, activeEncrypted).status);
        try {
            unlockBytes(password);
            requireCurrent(expected);
            return opened();
        } catch (Failure error) {
            closeNative();
            throw error;
        }
    }

    /** Drops cleartext native state but retains the encrypted image for unlock. */
    public void lockNow() { closeNative(); }

    /** Closes native ownership and erases the retained encrypted image. */
    public void closeNow() {
        closeNative();
        if (activeEncrypted != null) Arrays.fill(activeEncrypted, (byte)0);
        activeEncrypted = null;
        activeTarget = null;
    }

    private void closeNative() {
        if (nativeHandle != 0) NativeCore.nativeCloseContext(nativeHandle);
        nativeHandle = 0;
    }

    private void openContext() throws Failure {
        NativeCore.Result context = NativeCore.nativeCreateContext();
        check(context.status);
        nativeHandle = context.handle;
    }

    private void unlockBytes(String password) throws Failure {
        byte[] bytes = secret(password);
        try { check(NativeCore.nativeUnlock(nativeHandle, bytes).status); }
        finally { Arrays.fill(bytes, (byte)0); }
    }

    private JSONObject opened() throws Failure {
        NativeCore.Result result = NativeCore.nativeRead(nativeHandle);
        check(result.status);
        try {
            if (result.data == null || result.data.length > MAX_WEB_TEXT) {
                throw new Failure("LIMIT_EXCEEDED", "Document is too large for this view.");
            }
            String content;
            try { content = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(result.data)).toString(); }
            catch (CharacterCodingException error) {
                throw new Failure("MALFORMED_CONTENT", "Document text is invalid.");
            }
            int type = NativeCore.nativeContentType(nativeHandle);
            if (type != 0 && type != 1)
                throw new Failure("MALFORMED_CONTENT", "Document type is invalid.");
            return new JSONObject().put("content", content).put("readOnly", true)
                .put("canEdit", false).put("contentType", type == 1 ? "csv" : "plain-text")
                .put("publicationState", "target-published")
                .put("targetName", "Selected document");
        } catch (JSONException error) { throw new Failure("OPERATION_FAILED", "Document unavailable."); }
        finally { if (result.data != null) Arrays.fill(result.data, (byte)0); }
    }

    private static String text(JSONObject value, String name, int max, boolean empty)
            throws Failure {
        Object raw = value.opt(name);
        if (!(raw instanceof String)) throw new Failure("INVALID_ARGUMENT", "Invalid request.");
        String result = (String)raw;
        if ((!empty && result.isEmpty()) || result.getBytes(StandardCharsets.UTF_8).length > max)
            throw new Failure("INVALID_ARGUMENT", "Invalid request.");
        return result;
    }

    private static byte[] secret(String value) throws Failure {
        if (value == null) throw new Failure("INVALID_ARGUMENT", "Invalid password.");
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > 4096) {
            Arrays.fill(bytes, (byte)0);
            throw new Failure("INVALID_ARGUMENT", "Invalid password.");
        }
        return bytes;
    }

    private static void check(int status) throws Failure {
        if (status == NativeCore.OK) return;
        if (status == NativeCore.AUTHENTICATION_FAILED)
            throw new Failure("AUTHENTICATION_FAILED", "Password did not unlock this document.");
        if (status == NativeCore.MALFORMED_CONTAINER)
            throw new Failure("MALFORMED_CONTAINER", "Selected document is malformed.");
        if (status == 12) throw new Failure("WEAK_PASSWORD", "Password does not meet policy.");
        throw new Failure("OPERATION_FAILED", "Document operation failed.");
    }

    private static String hex(byte[] bytes) throws Failure {
        if (bytes == null || bytes.length != 16)
            throw new Failure("OPERATION_FAILED", "Document identity unavailable.");
        StringBuilder output = new StringBuilder(32);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }
}
