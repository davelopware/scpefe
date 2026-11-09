package org.scpefe.nativecore;

import android.content.Context;
import android.util.Base64;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.io.File;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONException;
import org.json.JSONObject;

/** Stores the shared AES-GCM work-journal envelope by authenticated document ID. */
public final class AndroidWorkJournals {
    /** Recovery state that the frontend must present before any publication claim. */
    public enum Attention { NONE, UNSAVED, PENDING_PUBLICATION, CONFLICT, UNREADABLE }

    /** A journal read paired with structured frontend attention. */
    public static final class Recovery {
        public final Attention attention;
        public final JSONObject record;
        private Recovery(Attention attention, JSONObject record) {
            this.attention = attention;
            this.record = record;
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private final PrivateStateFiles files;

    /** Uses app-private storage excluded by the application backup policy. */
    public AndroidWorkJournals(Context context) {
        files = new PrivateStateFiles(context, "work-journals");
    }

    AndroidWorkJournals(PrivateStateFiles files) { this.files = files; }

    /** Reads one journal after core authentication, preserving unreadable records. */
    public Recovery recover(String documentId, String target, byte[] journalKey) {
        try {
            JSONObject record = read(documentId, target, journalKey);
            if (record == null) return new Recovery(Attention.NONE, null);
            String state = record.optString("state");
            Attention attention = "pending-publication".equals(state)
                || "activity-outcome".equals(state) ? Attention.PENDING_PUBLICATION
                : "conflict".equals(state) ? Attention.CONFLICT : Attention.UNSAVED;
            return new Recovery(attention, record);
        } catch (IOException error) {
            return new Recovery(Attention.UNREADABLE, null);
        }
    }

    /** Reads a validated record only for its authenticated document and target. */
    public JSONObject read(String documentId, String target, byte[] journalKey)
            throws IOException {
        requireIdentity(documentId, target, journalKey);
        byte[] raw = files.read(documentId + ".work-journal");
        if (raw == null) return null;
        byte[] clear = null;
        try {
            JSONObject envelope = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (envelope.getInt("version") != 1) throw new JSONException("version");
            byte[] nonce = decode(envelope.getString("nonce"));
            byte[] tag = decode(envelope.getString("tag"));
            byte[] encrypted = decode(envelope.getString("ciphertext"));
            if (nonce.length != 12 || tag.length != 16) throw new JSONException("tag");
            byte[] combined = Arrays.copyOf(encrypted, encrypted.length + tag.length);
            System.arraycopy(tag, 0, combined, encrypted.length, tag.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(journalKey, "AES"),
                new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(documentId));
            clear = cipher.doFinal(combined);
            JSONObject record = new JSONObject(new String(clear, StandardCharsets.UTF_8));
            validateRecord(record, target);
            return record;
        } catch (JSONException | GeneralSecurityException | IllegalArgumentException error) {
            throw new IOException("work journal is unreadable", error);
        } finally {
            if (clear != null) Arrays.fill(clear, (byte)0);
        }
    }

    /** Encrypts a validated record; failed replacement leaves the previous file intact. */
    public void write(String documentId, String target, byte[] journalKey,
            JSONObject record) throws IOException {
        requireIdentity(documentId, target, journalKey);
        validateRecord(record, target);
        byte[] clear = record.toString().getBytes(StandardCharsets.UTF_8);
        try {
            byte[] nonce = new byte[12];
            RANDOM.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(journalKey, "AES"),
                new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(documentId));
            byte[] combined = cipher.doFinal(clear);
            int cipherLength = combined.length - 16;
            JSONObject envelope = new JSONObject();
            envelope.put("version", 1);
            envelope.put("nonce", encode(nonce));
            envelope.put("tag", encode(Arrays.copyOfRange(combined, cipherLength,
                combined.length)));
            envelope.put("ciphertext", encode(Arrays.copyOf(combined, cipherLength)));
            JSONObject publication = record.optJSONObject("publication");
            if (publication != null) {
                envelope.put("bootstrap", new JSONObject()
                    .put("targetHash", hex(sha256(target.getBytes(StandardCharsets.UTF_8))))
                    .put(publication.optBoolean("creation", false) ? "createCandidate" : "base",
                        publication.getString(publication.optBoolean("creation", false)
                            ? "candidate" : "base")));
            }
            files.write(documentId + ".work-journal",
                (envelope.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException | JSONException error) {
            throw new IOException("work journal could not be written", error);
        } finally {
            Arrays.fill(clear, (byte)0);
        }
    }

    /** Removes a journal only after verified publication or explicit discard. */
    public void clear(String documentId) throws IOException {
        if (!validDocumentId(documentId)) throw new IllegalArgumentException("document ID");
        java.nio.file.Files.deleteIfExists(files.file(documentId + ".work-journal").toPath());
    }

    /** Persists a new-document candidate before any provider write, with no false base image. */
    public void writePendingCreate(String documentId, String target, byte[] key,
            byte[] candidate, String text) throws IOException {
        if (candidate == null || candidate.length == 0 || text == null) {
            throw new IllegalArgumentException("candidate required");
        }
        byte[] id = new byte[16];
        RANDOM.nextBytes(id);
        try {
            JSONObject publication = new JSONObject()
                .put("target", target).put("id", hex(id))
                .put("candidateHash", hex(sha256(candidate)))
                .put("baseHash", hex(sha256(new byte[0])))
                .put("kind", "host-target").put("stage", "prepared")
                .put("creation", true).put("base", "")
                .put("candidate", encode(candidate));
            JSONObject record = new JSONObject().put("target", target)
                .put("baseRevision", "0".repeat(64))
                .put("updateTime", System.currentTimeMillis())
                .put("text", text).put("state", "pending-publication")
                .put("cursor", new JSONObject().put("start", 0).put("end", 0))
                .put("publication", publication);
            write(documentId, target, key, record);
        } catch (JSONException error) { throw new IOException("pending create is invalid", error); }
    }

    /** Counts unresolved private records without exposing or decrypting their contents. */
    public int unresolvedCount() {
        File[] records = files.file("placeholder").getParentFile().listFiles(
            (dir, name) -> name.matches("[0-9a-f]{32}\\.work-journal"));
        return records == null ? 0 : records.length;
    }

    private static void requireIdentity(String documentId, String target, byte[] key) {
        if (!validDocumentId(documentId) || target == null || target.isEmpty()
                || key == null || key.length != 32) {
            throw new IllegalArgumentException("invalid journal identity or key");
        }
    }

    private static boolean validDocumentId(String value) {
        return value != null && value.matches("[0-9a-f]{32}");
    }

    private static void validateRecord(JSONObject value, String target) throws IOException {
        try {
            if (value == null || !target.equals(value.getString("target"))
                    || !value.getString("baseRevision").matches("[0-9a-f]{64}")
                    || value.getLong("updateTime") < 0
                    || !value.has("text") || !(value.get("text") instanceof String)) {
                throw new JSONException("record identity");
            }
            String state = value.getString("state");
            if (!Arrays.asList("unsaved", "pending-publication", "conflict",
                    "activity-outcome").contains(state)) throw new JSONException("state");
            JSONObject activity = value.optJSONObject("activity");
            if ((value.has("activity") && activity == null)
                    || ("activity-outcome".equals(state) && activity == null)) {
                throw new JSONException("activity");
            }
            if (activity != null && (!Arrays.asList("backup", "export")
                    .contains(activity.getString("kind"))
                    || activity.getLong("attemptOperationId") < 1
                    || !activity.getString("attemptHead").matches("[0-9a-f]{64}")
                    || !(activity.get("succeeded") instanceof Boolean))) {
                throw new JSONException("activity");
            }
            JSONObject merge = value.optJSONObject("merge");
            if ((value.has("merge") && merge == null)
                    || (merge != null && (!"conflict".equals(state)
                        || !(merge.get("localContent") instanceof String)
                        || !merge.getString("ancestorRevision").matches("[0-9a-f]{64}")
                        || !merge.getString("localRevision").matches("[0-9a-f]{64}")
                        || !merge.getString("currentRevision").matches("[0-9a-f]{64}")))) {
                throw new JSONException("merge");
            }
            JSONObject cursor = value.getJSONObject("cursor");
            int start = cursor.getInt("start"), end = cursor.getInt("end");
            if (start < 0 || end < start || end > value.getString("text").length()) {
                throw new JSONException("cursor");
            }
            JSONObject publication = value.optJSONObject("publication");
            if (value.has("publication") && publication == null) {
                throw new JSONException("publication");
            }
            if (publication != null) {
                if (!target.equals(publication.getString("target"))
                        || !publication.getString("id").matches("[0-9a-f]{32}")
                        || !publication.getString("candidateHash").matches("[0-9a-f]{64}")
                        || !publication.getString("baseHash").matches("[0-9a-f]{64}")
                        || !"host-target".equals(publication.getString("kind"))
                        || !Arrays.asList("prepared", "written", "flushed", "replaced",
                            "verified", "cleanup").contains(publication.getString("stage"))) {
                    throw new JSONException("publication");
                }
                byte[] base = decode(publication.getString("base"));
                byte[] candidate = decode(publication.getString("candidate"));
                boolean creation = publication.optBoolean("creation", false);
                if ((base.length == 0 && !creation) || candidate.length == 0
                        || (creation && (!"pending-publication".equals(state)
                            || !"0".repeat(64).equals(value.getString("baseRevision"))))
                        || !hex(sha256(base)).equals(publication.getString("baseHash"))
                        || !hex(sha256(candidate)).equals(publication.getString("candidateHash"))) {
                    throw new JSONException("candidate");
                }
            }
        } catch (JSONException | IllegalArgumentException error) {
            throw new IOException("work journal record is invalid", error);
        }
    }

    private static byte[] aad(String documentId) {
        return ("scpefe-work-journal-v1:" + documentId).getBytes(StandardCharsets.US_ASCII);
    }

    private static byte[] decode(String value) {
        return Base64.decode(value, Base64.NO_WRAP);
    }

    private static String encode(byte[] value) {
        return Base64.encodeToString(value, Base64.NO_WRAP);
    }

    private static byte[] sha256(byte[] value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value); }
        catch (GeneralSecurityException error) { throw new AssertionError(error); }
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder();
        for (byte element : value) result.append(String.format("%02x", element & 0xff));
        return result.toString();
    }
}
