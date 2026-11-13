package org.scpefe.nativecore;

import android.content.Context;
import android.os.SystemClock;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;
import android.util.Base64;
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
    private static final SecureRandom RANDOM = new SecureRandom();
    private final AndroidDocumentTargets targets;
    private final AndroidProfileSettings profiles;
    private final AndroidWorkJournals journals;
    private final AtomicLong generation = new AtomicLong();
    private String selectedTarget;
    private String activeTarget;
    private byte[] activeEncrypted;
    private byte[] activePassword;
    private byte[] leaseSession;
    private String journalScope;
    private long journalRevision;
    private boolean pendingSave;
    private long pendingSaveOperationId;
    private long lastRegularSaveAt;
    private long lastRegularSaveRevision;
    private long lastLeaseRefreshAt;
    private long nativeHandle;
    private boolean checkpointFailed;
    private boolean screenLocked;

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

    /** Reports whether a document still exposes plaintext to the renderer. */
    public boolean isUnlocked() {
        return activeTarget != null && nativeHandle != 0 && !screenLocked;
    }

    /** Reports a retained document whose renderer must stay in the locked view. */
    public boolean isLocked() { return activeTarget != null && screenLocked; }

    /** Returns a visible lock warning after a failed mandatory checkpoint. */
    public String lockWarning() {
        return checkpointFailed ? "LOCK_CHECKPOINT_FAILED" : null;
    }

    /** Force-flushes current native text after queued renderer edits have settled. */
    public String forceCheckpoint() {
        if (screenLocked || nativeHandle == 0 || leaseSession == null || pendingSave)
            return checkpointFailed ? "RECOVERY_CHECKPOINT_FAILED" : null;
        try {
            AndroidWorkJournals.Recovery recovery = recovery();
            if (recovery.attention == AndroidWorkJournals.Attention.UNSAVED
                    || (checkpointFailed && recovery.attention == AndroidWorkJournals.Attention.NONE)) {
                String content = openedText();
                NativeCore.LeaseState state = leaseState();
                JSONObject cursor = recovery.record == null ? null
                    : recovery.record.optJSONObject("cursor");
                int start = cursor == null ? content.length()
                    : Math.min(cursor.optInt("start", content.length()), content.length());
                int end = cursor == null ? start
                    : Math.max(start, Math.min(cursor.optInt("end", start), content.length()));
                JSONObject record = new JSONObject().put("target", activeTarget)
                    .put("baseRevision", hex(state.revisionHead, 32))
                    .put("targetHash", hash(activeEncrypted))
                    .put("updateTime", System.currentTimeMillis())
                    .put("text", content).put("state", "unsaved")
                    .put("cursor", new JSONObject().put("start", start).put("end", end));
                byte[] key = journalKey();
                try { journals.write(documentId(), activeTarget, key, record); }
                finally { Arrays.fill(key, (byte)0); }
                checkpointFailed = false;
            }
        } catch (Failure | IOException | JSONException error) {
            checkpointFailed = true;
        }
        return checkpointFailed ? "RECOVERY_CHECKPOINT_FAILED" : null;
    }

    /** Refreshes an active editing lease while the unlocked session is still current. */
    public void refreshLeaseIfDue(long now) throws Failure {
        if (screenLocked || leaseSession == null || pendingSave
                || now - lastLeaseRefreshAt < 60_000) return;
        NativeCore.LeaseState state = leaseState();
        if (!state.editing || !state.active
                || !Arrays.equals(state.sessionId, leaseSession))
            throw new Failure("LEASE_REFRESH_FAILED", "The editing lease changed.");
        verifyTarget();
        AndroidWorkJournals.Recovery recovery = recovery();
        if (recovery.attention == AndroidWorkJournals.Attention.PENDING_PUBLICATION
                || recovery.attention == AndroidWorkJournals.Attention.CONFLICT
                || recovery.attention == AndroidWorkJournals.Attention.UNREADABLE)
            throw new Failure("LEASE_REFRESH_FAILED", "Recovery must be resolved first.");
        publishLease(2, leaseSession, recovery.record, generation.get());
    }

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
                String documentId = hex(read.documentId, 16);
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
            activePassword = ownerBytes.clone();
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
            activePassword = secret(password);
            selectedTarget = null;
            requireCurrent(expected);
            return opened();
        } catch (Failure error) {
            closeNow();
            throw error;
        } finally { Arrays.fill(bytes, (byte)0); }
    }

    /** Reauthenticates the retained session and resumes its unchanged editing lease. */
    public JSONObject unlock(String password, long expected) throws Failure {
        requireCurrent(expected);
        if (activeEncrypted == null) throw new Failure("INVALID_STATE", "No locked document.");
        if (nativeHandle == 0) {
            openContext();
            check(NativeCore.nativeOpen(nativeHandle, activeEncrypted).status);
        }
        try {
            unlockBytes(password);
            screenLocked = false;
            clearPassword();
            activePassword = secret(password);
            requireCurrent(expected);
            if (leaseSession != null && !pendingSave) {
                NativeCore.LeaseState state = leaseState();
                if (state.active && Arrays.equals(state.sessionId, leaseSession)) {
                    try {
                        verifyTarget();
                        AndroidWorkJournals.Recovery recovery = recovery();
                        if (recovery.attention == AndroidWorkJournals.Attention.NONE)
                            publishLease(4, leaseSession, null, expected);
                    } catch (Failure ignored) {
                        // Keep the verified image available read-only and retain recovery.
                    }
                }
            }
            return opened();
        } catch (Failure error) {
            throw error;
        }
    }

    /** Hides the session without publishing a lease release; checkpoints are already serial. */
    public String lockNow() {
        if (screenLocked) return lockWarning();
        forceCheckpoint();
        if (nativeHandle != 0) {
            if (pendingSave || NativeCore.nativeLock(nativeHandle).status != NativeCore.OK) {
                closeNative();
                pendingSaveOperationId = 0;
            }
        }
        screenLocked = true;
        return lockWarning();
    }

    /** Closes native ownership and erases the retained encrypted image. */
    public void closeNow() {
        if (screenLocked && nativeHandle != 0 && activePassword != null
                && !pendingSave) {
            NativeCore.nativeUnlock(nativeHandle, activePassword);
        }
        screenLocked = false;
        releaseLease();
        closeNative();
        if (activeEncrypted != null) Arrays.fill(activeEncrypted, (byte)0);
        activeEncrypted = null;
        activeTarget = null;
        clearPassword();
        journalScope = null;
        journalRevision = 0;
        pendingSave = false;
        pendingSaveOperationId = 0;
        lastRegularSaveRevision = 0;
        lastLeaseRefreshAt = 0;
        checkpointFailed = false;
    }

    private void clearPassword() {
        if (activePassword != null) Arrays.fill(activePassword, (byte)0);
        activePassword = null;
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

    private NativeCore.LeaseState leaseState() throws Failure {
        NativeCore.LeaseState state = NativeCore.nativeLeaseState(nativeHandle);
        if (state == null || state.status != NativeCore.OK) {
            throw new Failure("OPERATION_FAILED", "Authenticated lease state unavailable.");
        }
        return state;
    }

    private String documentId() throws Failure {
        NativeCore.Result read = NativeCore.nativeRead(nativeHandle);
        check(read.status);
        try { return hex(read.documentId, 16); }
        finally { if (read.data != null) Arrays.fill(read.data, (byte)0); }
    }

    private byte[] journalKey() throws Failure {
        NativeCore.Result result = NativeCore.nativeJournalKey(nativeHandle);
        check(result.status);
        if (result.data == null || result.data.length != 32) {
            throw new Failure("OPERATION_FAILED", "Recovery key unavailable.");
        }
        return result.data;
    }

    /** Acquires the core lease through exact provider publication, never a content save. */
    public JSONObject enterEdit(long expected) throws Failure {
        requireCurrent(expected);
        if (activeTarget == null || activeEncrypted == null || activePassword == null)
            throw new Failure("INVALID_STATE", "Open a document first.");
        NativeCore.LeaseState state = leaseState();
        if (!state.canEdit || state.mustChangePassword)
            throw new Failure("EDIT_DENIED", "This password slot cannot edit.");
        boolean resuming = leaseSession != null && state.active
            && Arrays.equals(state.sessionId, leaseSession);
        if ((state.active && !resuming) || state.editing)
            throw new Failure("LEASE_ACTIVE", "Another editing lease is active.");
        verifyTarget();
        byte[] session = resuming ? leaseSession : new byte[16];
        if (!resuming) {
            RANDOM.nextBytes(session);
            if (allZero(session)) session[0] = 1;
        }
        AndroidWorkJournals.Recovery recovery = recovery();
        if (recovery.attention == AndroidWorkJournals.Attention.UNSAVED)
            throw new Failure("RECOVERY_REQUIRED", "Restore or discard recovered work first.");
        if (recovery.attention == AndroidWorkJournals.Attention.PENDING_PUBLICATION
                || recovery.attention == AndroidWorkJournals.Attention.CONFLICT
                || recovery.attention == AndroidWorkJournals.Attention.UNREADABLE)
            throw new Failure("PUBLICATION_PENDING", "Resolve local recovery first.");
        publishLease(resuming ? 4 : 1, session, null, expected);
        leaseSession = session;
        journalScope = null;
        journalRevision = 0;
        lastRegularSaveAt = System.currentTimeMillis();
        lastRegularSaveRevision = 0;
        requireCurrent(expected);
        return opened(false);
    }

    /** Restores only the authenticated, unchanged document's encrypted draft. */
    public JSONObject restoreRecovered(long expected) throws Failure {
        requireCurrent(expected);
        AndroidWorkJournals.Recovery recovery = recovery();
        if (recovery.attention != AndroidWorkJournals.Attention.UNSAVED)
            throw new Failure("RECOVERY_UNAVAILABLE", "No recoverable work is available.");
        JSONObject record = recovery.record;
        if (!hex(leaseState().revisionHead, 32).equals(record.optString("baseRevision"))
                || !hash(activeEncrypted).equals(record.optString("targetHash"))) {
            throw new Failure("TARGET_CHANGED", "The document changed since the checkpoint.");
        }
        NativeCore.LeaseState state = leaseState();
        if (!state.canEdit || state.mustChangePassword)
            throw new Failure("EDIT_DENIED", "This password slot cannot edit.");
        boolean resuming = leaseSession != null && state.active
            && Arrays.equals(state.sessionId, leaseSession);
        if ((state.active && !resuming) || state.editing)
            throw new Failure("LEASE_ACTIVE", "The editing lease changed.");
        verifyTarget();
        byte[] session = resuming ? leaseSession : new byte[16];
        if (!resuming) {
            RANDOM.nextBytes(session);
            if (allZero(session)) session[0] = 1;
        }
        publishLease(resuming ? 4 : 1, session, record, expected);
        leaseSession = session;
        String content = record.optString("text", "");
        byte[] clear = content.getBytes(StandardCharsets.UTF_8);
        try { check(NativeCore.nativeSubmitContent(nativeHandle, clear).status); }
        finally { Arrays.fill(clear, (byte)0); }
        journalScope = null;
        journalRevision = 0;
        lastRegularSaveAt = System.currentTimeMillis();
        lastRegularSaveRevision = 0;
        requireCurrent(expected);
        try {
            return opened(false).put("content", content)
                .put("recoveredUnsaved", true).put("cursor", record.getJSONObject("cursor"));
        } catch (JSONException error) {
            throw new Failure("RECOVERY_UNAVAILABLE", "Recovery cursor is invalid.");
        }
    }

    /** Submits canonical text to the native editor, then durably checkpoints it. */
    public void updateWorkingCopy(JSONObject update, long expected) throws Failure {
        requireCurrent(expected);
        if (activeTarget == null || activePassword == null || leaseSession == null)
            throw new Failure("INVALID_STATE", "No editing session is active.");
        NativeCore.LeaseState state = leaseState();
        if (!state.editing || !state.active
                || !Arrays.equals(state.sessionId, leaseSession))
            throw new Failure("LEASE_CHANGED", "The editing lease changed.");
        verifyTarget();
        String content = text(update, "content", MAX_WEB_TEXT, true);
        String scope = text(update, "journalScope", 128, false);
        long revision = update.optLong("revision", -1);
        if (revision < 1 || (journalScope != null && !journalScope.equals(scope))
                || revision <= journalRevision)
            throw new Failure("STALE_OPERATION", "The working copy update is stale.");
        JSONObject cursor = update.optJSONObject("cursor");
        if (cursor == null || cursor.optInt("start", -1) < 0
                || cursor.optInt("end", -1) < cursor.optInt("start", -1)
                || cursor.optInt("end", -1) > content.length())
            throw new Failure("INVALID_ARGUMENT", "Invalid editor selection.");
        byte[] clear = content.getBytes(StandardCharsets.UTF_8);
        byte[] key = journalKey();
        try {
            check(NativeCore.nativeSubmitContent(nativeHandle, clear).status);
            JSONObject record = new JSONObject().put("target", activeTarget)
                .put("baseRevision", hex(state.revisionHead, 32))
                .put("targetHash", hash(activeEncrypted))
                .put("updateTime", System.currentTimeMillis())
                .put("text", content).put("state", "unsaved")
                .put("cursor", new JSONObject().put("start", cursor.getInt("start"))
                    .put("end", cursor.getInt("end")));
            requireCurrent(expected);
            journals.write(documentId(), activeTarget, key, record);
            checkpointFailed = false;
            journalScope = scope;
            journalRevision = revision;
            requireCurrent(expected);
        } catch (IOException | JSONException error) {
            checkpointFailed = true;
            throw new Failure("RECOVERY_CHECKPOINT_FAILED",
                "Could not preserve the encrypted working copy.");
        } finally {
            Arrays.fill(clear, (byte)0);
            Arrays.fill(key, (byte)0);
        }
    }

    /** Journals the exact native save candidate before conditional provider publication. */
    public JSONObject save(JSONObject request, boolean manual, long expected) throws Failure {
        requireCurrent(expected);
        if (activeTarget == null || activeEncrypted == null || activePassword == null
                || leaseSession == null || pendingSave)
            throw new Failure("INVALID_STATE", "No available editing session.");
        AndroidWorkJournals.Recovery prior = recovery();
        if (prior.attention == AndroidWorkJournals.Attention.PENDING_PUBLICATION
                || prior.attention == AndroidWorkJournals.Attention.CONFLICT)
            throw new Failure("PUBLICATION_PENDING", "Resolve the prior candidate first.");
        NativeCore.LeaseState state = leaseState();
        if (!state.active || !state.editing
                || !Arrays.equals(state.sessionId, leaseSession))
            throw new Failure("LEASE_CHANGED", "The editing lease changed.");
        String content = text(request, "content", MAX_WEB_TEXT, true);
        String scope = request.optString("journalScope", "");
        long revision = request.optLong("revision", 0);
        if ((!scope.isEmpty() && !scope.matches("[A-Za-z0-9_-]{1,128}"))
                || (scope.isEmpty() != (revision == 0))
                || (revision > 0 && (journalScope == null
                    || !journalScope.equals(scope) || revision > journalRevision)))
            throw new Failure("STALE_OPERATION", "The working copy version is unavailable.");
        JSONObject newer = revision > 0 && journalRevision > revision
                && prior.attention == AndroidWorkJournals.Attention.UNSAVED
            ? prior.record : null;
        if (revision > 0 && journalRevision > revision && newer == null)
            throw new Failure("STALE_OPERATION", "The newer checkpoint is unavailable.");
        JSONObject profile;
        try { profile = profiles.loadProfile(); }
        catch (IOException error) { throw new Failure("PROFILE_UNAVAILABLE", "Profile unavailable."); }
        if (profile == null) throw new Failure("PROFILE_REQUIRED", "Configure a profile first.");
        byte[] name = profile.optString("name").getBytes(StandardCharsets.UTF_8);
        byte[] email = profile.optString("email").getBytes(StandardCharsets.UTF_8);
        byte[] device = profile.optString("deviceName").getBytes(StandardCharsets.UTF_8);
        byte[] clear = content.getBytes(StandardCharsets.UTF_8);
        byte[] key = journalKey();
        byte[] base = activeEncrypted.clone();
        NativeCore.Result prepared = null;
        try {
            check(NativeCore.nativeSubmitContent(nativeHandle, clear).status);
            prepared = NativeCore.nativePrepareSave(nativeHandle, manual ? 1 : 2,
                System.nanoTime() & Long.MAX_VALUE, activePassword, name, email,
                device, System.currentTimeMillis());
            check(prepared.status);
            if (prepared.data == null || prepared.data.length == 0)
                throw new Failure("OPERATION_FAILED", "Save candidate unavailable.");
            JSONObject publication = new JSONObject()
                .put("target", activeTarget).put("id", randomId())
                .put("candidateHash", hash(prepared.data))
                .put("baseHash", hash(base))
                .put("kind", "host-target").put("stage", "prepared")
                .put("purpose", manual ? "manual-save" : "regular-save")
                .put("candidateText", content)
                .put("base", Base64.encodeToString(base, Base64.NO_WRAP))
                .put("candidate", Base64.encodeToString(prepared.data, Base64.NO_WRAP));
            JSONObject record = new JSONObject().put("target", activeTarget)
                .put("baseRevision", hex(state.revisionHead, 32))
                .put("targetHash", hash(base))
                .put("updateTime", System.currentTimeMillis())
                .put("text", newer == null ? content : newer.getString("text"))
                .put("state", "pending-publication")
                .put("cursor", new JSONObject().put("start", 0).put("end", 0))
                .put("publication", publication);
            String id = documentId();
            try { journals.write(id, activeTarget, key, record); }
            catch (IOException error) {
                check(NativeCore.nativeAcknowledgeSave(nativeHandle,
                    prepared.handle, 2).status);
                throw error;
            }
            pendingSave = true;
            pendingSaveOperationId = prepared.handle;
            requireCurrent(expected);
            TargetPublication.Outcome outcome = targets.publish(activeTarget,
                base, prepared.data);
            boolean conflict = false;
            if (outcome != TargetPublication.Outcome.VERIFIED) {
                try {
                    byte[] observed = targets.read(activeTarget);
                    if (Arrays.equals(observed, prepared.data))
                        outcome = TargetPublication.Outcome.VERIFIED;
                    else conflict = !Arrays.equals(observed, base);
                    Arrays.fill(observed, (byte)0);
                } catch (IOException ignored) {
                    // Keep the candidate pending until the actual target can be reread.
                }
            }
            int code = outcome == TargetPublication.Outcome.VERIFIED ? 1
                : outcome == TargetPublication.Outcome.DEFINITE_FAILURE && !conflict ? 2 : 3;
            check(NativeCore.nativeAcknowledgeSave(nativeHandle,
                prepared.handle, code).status);
            if (conflict) {
                record.put("state", "conflict");
                journals.write(id, activeTarget, key, record);
                pendingSaveOperationId = code == 2 ? 0 : prepared.handle;
                return saveResult(content, scope, revision, "conflict");
            }
            if (outcome == TargetPublication.Outcome.DEFINITE_FAILURE) {
                pendingSaveOperationId = 0;
                if (manual) return saveResult(content, scope, revision,
                    "pending-publication");
                if (newer != null) {
                    journals.write(id, activeTarget, key, newer);
                    restoreNativeText(newer.getString("text"));
                } else {
                    record.put("state", "unsaved").remove("publication");
                    journals.write(id, activeTarget, key, record);
                }
                pendingSave = false;
                throw new Failure("PUBLICATION_FAILED", "The provider refused the save.");
            }
            if (outcome == TargetPublication.Outcome.AMBIGUOUS) {
                return saveResult(content, scope, revision, "pending-publication");
            }
            pendingSaveOperationId = 0;
            Arrays.fill(activeEncrypted, (byte)0);
            activeEncrypted = prepared.data.clone();
            if (newer == null) journals.clear(id);
            else {
                NativeCore.LeaseState saved = leaseState();
                newer.put("baseRevision", hex(saved.revisionHead, 32))
                    .put("targetHash", hash(activeEncrypted));
                journals.write(id, activeTarget, key, newer);
                restoreNativeText(newer.getString("text"));
            }
            lastRegularSaveAt = System.currentTimeMillis();
            lastRegularSaveRevision = revision;
            pendingSave = false;
            return saveResult(content, scope, revision, "target-published");
        } catch (IOException | JSONException error) {
            throw new Failure("PRIVATE_STATE_UNAVAILABLE",
                "Could not preserve the encrypted save candidate.");
        } finally {
            Arrays.fill(name, (byte)0); Arrays.fill(email, (byte)0);
            Arrays.fill(device, (byte)0); Arrays.fill(clear, (byte)0);
            Arrays.fill(key, (byte)0); Arrays.fill(base, (byte)0);
            if (prepared != null && prepared.data != null)
                Arrays.fill(prepared.data, (byte)0);
        }
    }

    private static JSONObject saveResult(String content, String scope, long revision,
            String publicationState) throws JSONException {
        JSONObject result = new JSONObject().put("saved", true)
            .put("content", content).put("publicationState", publicationState);
        if (revision > 0) result.put("journalScope", scope).put("revision", revision);
        return result;
    }

    private void restoreNativeText(String content) throws Failure {
        byte[] latest = content.getBytes(StandardCharsets.UTF_8);
        try { check(NativeCore.nativeSubmitContent(nativeHandle, latest).status); }
        finally { Arrays.fill(latest, (byte)0); }
    }

    /** Publishes a provisional revision only when settings and a newer checkpoint allow it. */
    public JSONObject regularSaveIfDue(long now) throws Failure {
        if (screenLocked || leaseSession == null || pendingSave || journalScope == null
                || journalRevision <= lastRegularSaveRevision) return null;
        JSONObject settings;
        try { settings = profiles.loadSettings(); }
        catch (IOException error) { return null; }
        long interval = settings.optLong("regularSaveIntervalMs", 120_000);
        if (!settings.optBoolean("regularSaveEnabled")
                || now - lastRegularSaveAt < interval) return null;
        String scope = journalScope;
        long revision = journalRevision;
        JSONObject request = new JSONObject();
        try {
            request.put("content", openedText()).put("journalScope", scope)
                .put("revision", revision);
        } catch (JSONException error) { throw new AssertionError(error); }
        JSONObject result = save(request, false, generation.get());
        if (!"target-published".equals(result.optString("publicationState"))) return null;
        try { return new JSONObject().put("published", true)
            .put("provisional", true).put("content", result.getString("content"))
            .put("journalScope", scope).put("revision", revision); }
        catch (JSONException error) { throw new AssertionError(error); }
    }

    /** Reuses the journaled candidate byte-for-byte after an ambiguous provider result. */
    public JSONObject reconnectPending(long expected) throws Failure {
        requireCurrent(expected);
        if (activeTarget == null || activePassword == null)
            throw new Failure("INVALID_STATE", "Open the affected document first.");
        AndroidWorkJournals.Recovery recovery = recovery();
        if (recovery.attention != AndroidWorkJournals.Attention.PENDING_PUBLICATION
                && recovery.attention != AndroidWorkJournals.Attention.CONFLICT)
            throw new Failure("PUBLICATION_MISSING", "No pending candidate is available.");
        JSONObject record = recovery.record;
        byte[] base, candidate;
        String publishedText;
        try {
            JSONObject publication = record.getJSONObject("publication");
            publishedText = publication.optString("candidateText",
                record.getString("text"));
            base = Base64.decode(publication.getString("base"), Base64.DEFAULT);
            candidate = Base64.decode(publication.getString("candidate"), Base64.DEFAULT);
            if (!hash(base).equals(publication.getString("baseHash"))
                    || !hash(candidate).equals(publication.getString("candidateHash")))
                throw new Failure("RECOVERY_UNAVAILABLE", "Pending candidate is invalid.");
        } catch (JSONException | IllegalArgumentException error) {
            throw new Failure("RECOVERY_UNAVAILABLE", "Pending candidate is invalid.");
        }
        try {
            TargetPublication.Outcome outcome = targets.publish(activeTarget,
                base, candidate);
            if (outcome != TargetPublication.Outcome.VERIFIED) {
                try {
                    byte[] observed = targets.read(activeTarget);
                    if (!Arrays.equals(observed, base)
                            && !Arrays.equals(observed, candidate)) {
                        record.put("state", "conflict");
                        byte[] key = journalKey();
                        try { journals.write(documentId(), activeTarget, key, record); }
                        finally { Arrays.fill(key, (byte)0); }
                        return new JSONObject().put("content", publishedText)
                            .put("publicationState", "conflict");
                    }
                } catch (IOException ignored) {
                    // The provider is still unavailable; retain the exact candidate.
                }
                return new JSONObject().put("content", publishedText)
                    .put("publicationState", "pending-publication");
            }
            if (pendingSaveOperationId > 0)
                check(NativeCore.nativeResolveSave(nativeHandle,
                    pendingSaveOperationId, true).status);
            else {
                closeNative();
                openContext();
                check(NativeCore.nativeOpen(nativeHandle, candidate).status);
                check(NativeCore.nativeUnlock(nativeHandle, activePassword).status);
            }
            Arrays.fill(activeEncrypted, (byte)0);
            activeEncrypted = candidate.clone();
            boolean newer = !record.getString("text").equals(publishedText);
            if (newer) {
                NativeCore.LeaseState saved = leaseState();
                record.put("state", "unsaved")
                    .put("baseRevision", hex(saved.revisionHead, 32))
                    .put("targetHash", hash(activeEncrypted)).remove("publication");
                byte[] key = journalKey();
                try { journals.write(documentId(), activeTarget, key, record); }
                finally { Arrays.fill(key, (byte)0); }
                if (pendingSaveOperationId > 0)
                    restoreNativeText(record.getString("text"));
            } else journals.clear(documentId());
            pendingSave = false;
            pendingSaveOperationId = 0;
            NativeCore.LeaseState state = leaseState();
            leaseSession = state.active ? state.sessionId.clone() : null;
            if (leaseSession != null) releaseLease();
            requireCurrent(expected);
            return new JSONObject().put("content", publishedText)
                .put("publicationState", "target-published");
        } catch (IOException | JSONException error) {
            throw new Failure("PRIVATE_STATE_UNAVAILABLE",
                "Could not reconcile the encrypted save candidate.");
        } finally {
            Arrays.fill(base, (byte)0);
            Arrays.fill(candidate, (byte)0);
        }
    }

    private void verifyTarget() throws Failure {
        try {
            byte[] observed = targets.read(activeTarget);
            try {
                if (!Arrays.equals(observed, activeEncrypted))
                    throw new Failure("TARGET_CHANGED", "The selected document changed.");
            } finally { Arrays.fill(observed, (byte)0); }
        } catch (IOException error) {
            throw new Failure("TARGET_UNAVAILABLE", "Selected document is unavailable.");
        }
    }

    private AndroidWorkJournals.Recovery recovery() throws Failure {
        if (activeTarget == null) return null;
        byte[] key = journalKey();
        try { return journals.recover(documentId(), activeTarget, key); }
        finally { Arrays.fill(key, (byte)0); }
    }

    private void publishLease(int action, byte[] session, JSONObject existing,
            long expected) throws Failure {
        JSONObject profile;
        try { profile = profiles.loadProfile(); }
        catch (IOException error) { throw new Failure("PROFILE_UNAVAILABLE", "Profile unavailable."); }
        if (profile == null) throw new Failure("PROFILE_REQUIRED", "Configure a profile first.");
        byte[] name = profile.optString("name").getBytes(StandardCharsets.UTF_8);
        byte[] email = profile.optString("email").getBytes(StandardCharsets.UTF_8);
        byte[] device = profile.optString("deviceName").getBytes(StandardCharsets.UTF_8);
        byte[] key = journalKey();
        byte[] base = activeEncrypted.clone();
        String id = documentId();
        NativeCore.LeaseState state = leaseState();
        String baseText = existing == null ? openedText() : null;
        NativeCore.Result prepared = null;
        try {
            prepared = NativeCore.nativePrepareLease(nativeHandle, action,
                System.nanoTime() & Long.MAX_VALUE, activePassword, session,
                name, email, device, System.currentTimeMillis());
            check(prepared.status);
            if (prepared.data == null || prepared.data.length == 0)
                throw new Failure("OPERATION_FAILED", "Lease candidate unavailable.");
            JSONObject pending = existing == null ? new JSONObject()
                .put("target", activeTarget).put("baseRevision", hex(state.revisionHead, 32))
                .put("updateTime", System.currentTimeMillis())
                .put("text", baseText).put("state", "pending-publication")
                .put("cursor", new JSONObject().put("start", 0).put("end", 0))
                : new JSONObject(existing.toString()).put("state", "pending-publication");
            pending.put("publication", new JSONObject()
                .put("target", activeTarget).put("id", randomId())
                .put("candidateHash", hash(prepared.data)).put("baseHash", hash(base))
                .put("kind", "host-target").put("stage", "prepared")
                .put("purpose", "lease-change")
                .put("base", Base64.encodeToString(base, Base64.NO_WRAP))
                .put("candidate", Base64.encodeToString(prepared.data, Base64.NO_WRAP)));
            journals.write(id, activeTarget, key, pending);
            requireCurrent(expected);
            TargetPublication.Outcome outcome = targets.publish(activeTarget,
                base, prepared.data);
            int nativeOutcome = outcome == TargetPublication.Outcome.VERIFIED ? 1
                : outcome == TargetPublication.Outcome.DEFINITE_FAILURE ? 2 : 3;
            check(NativeCore.nativeAcknowledgeLease(nativeHandle,
                prepared.handle, nativeOutcome).status);
            if (outcome == TargetPublication.Outcome.DEFINITE_FAILURE) {
                if (existing == null) journals.clear(id);
                else journals.write(id, activeTarget, key, existing);
            }
            if (outcome != TargetPublication.Outcome.VERIFIED)
                throw new Failure(outcome == TargetPublication.Outcome.AMBIGUOUS
                    ? "PUBLICATION_AMBIGUOUS" : "PUBLICATION_FAILED",
                    "Editing lease could not be verified.");
            Arrays.fill(activeEncrypted, (byte)0);
            activeEncrypted = prepared.data.clone();
            if (existing == null) journals.clear(id);
            else {
                JSONObject restored = new JSONObject(existing.toString())
                    .put("targetHash", hash(activeEncrypted));
                journals.write(id, activeTarget, key, restored);
            }
            if (action != 3) lastLeaseRefreshAt = SystemClock.elapsedRealtime();
        } catch (IOException | JSONException error) {
            throw new Failure("PRIVATE_STATE_UNAVAILABLE",
                "Could not preserve lease publication state.");
        } finally {
            Arrays.fill(name, (byte)0); Arrays.fill(email, (byte)0);
            Arrays.fill(device, (byte)0); Arrays.fill(key, (byte)0);
            Arrays.fill(base, (byte)0);
            if (prepared != null && prepared.data != null)
                Arrays.fill(prepared.data, (byte)0);
        }
    }

    private void releaseLease() {
        if (pendingSave || nativeHandle == 0 || activeTarget == null || leaseSession == null
                || activePassword == null) return;
        try {
            AndroidWorkJournals.Recovery recovery = recovery();
            publishLease(3, leaseSession,
                recovery != null && recovery.attention == AndroidWorkJournals.Attention.UNSAVED
                    ? recovery.record : null, generation.get());
        } catch (Failure ignored) {
            // The pending encrypted candidate remains for explicit recovery.
        } finally {
            Arrays.fill(leaseSession, (byte)0);
            leaseSession = null;
        }
    }

    private String openedText() throws Failure {
        NativeCore.Result read = NativeCore.nativeRead(nativeHandle);
        check(read.status);
        try { return new String(read.data, StandardCharsets.UTF_8); }
        finally { Arrays.fill(read.data, (byte)0); }
    }

    private static boolean allZero(byte[] value) {
        for (byte element : value) if (element != 0) return false;
        return true;
    }

    private static String randomId() {
        byte[] bytes = new byte[16]; RANDOM.nextBytes(bytes);
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    private static String hash(byte[] value) {
        try { return hexHash(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (NoSuchAlgorithmException error) { throw new AssertionError(error); }
    }

    private static String hexHash(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    private void unlockBytes(String password) throws Failure {
        byte[] bytes = secret(password);
        try { check(NativeCore.nativeUnlock(nativeHandle, bytes).status); }
        finally { Arrays.fill(bytes, (byte)0); }
    }

    private JSONObject opened() throws Failure { return opened(true); }

    private JSONObject opened(boolean includeRecovery) throws Failure {
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
            NativeCore.LeaseState state = leaseState();
            JSONObject value = new JSONObject().put("content", content)
                .put("readOnly", !state.editing)
                .put("canEdit", state.canEdit && !state.mustChangePassword)
                .put("contentType", type == 1 ? "csv" : "plain-text")
                .put("publicationState", "target-published")
                .put("targetName", "Selected document");
            if (!state.manuallySealed) value.put("provisional", true);
            if (includeRecovery && activeTarget != null) {
                AndroidWorkJournals.Recovery recovery = recovery();
                if (recovery.attention == AndroidWorkJournals.Attention.UNSAVED) {
                    JSONObject record = recovery.record;
                    boolean mismatch = (state.active && (leaseSession == null
                        || !Arrays.equals(state.sessionId, leaseSession)))
                        || !hex(state.revisionHead, 32).equals(
                        record.optString("baseRevision"))
                        || !hash(activeEncrypted).equals(record.optString("targetHash"));
                    value.put("recovery", new JSONObject()
                        .put("content", record.getString("text"))
                        .put("state", "unsaved")
                        .put("updateTime", record.getLong("updateTime"))
                        .put("cursor", record.getJSONObject("cursor"))
                        .put("baseMismatch", mismatch));
                } else if (recovery.attention == AndroidWorkJournals.Attention.UNREADABLE) {
                    value.put("unreadableJournal", true);
                } else if (recovery.attention == AndroidWorkJournals.Attention.PENDING_PUBLICATION) {
                    value.put("publicationState", "pending-publication");
                } else if (recovery.attention == AndroidWorkJournals.Attention.CONFLICT) {
                    value.put("publicationState", "conflict");
                }
            }
            return value;
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

    private static String hex(byte[] bytes, int expectedLength) throws Failure {
        if (bytes == null || bytes.length != expectedLength)
            throw new Failure("OPERATION_FAILED", "Native identifier unavailable.");
        StringBuilder output = new StringBuilder(expectedLength * 2);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }
}
