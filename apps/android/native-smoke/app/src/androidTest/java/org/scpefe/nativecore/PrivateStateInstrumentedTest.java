package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Process;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises Android app-private state with interruption and restart boundaries. */
@RunWith(AndroidJUnit4.class)
public final class PrivateStateInstrumentedTest {
    private static final String DOCUMENT = "12121212121212121212121212121212";
    private static final String OTHER = "13131313131313131313131313131313";
    private static final String TARGET = "android-target:fixture";
    private static final String REVISION =
        "3434343434343434343434343434343434343434343434343434343434343434";

    private File directory() throws IOException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getFilesDir(), "test-state-" + System.nanoTime());
        if (!directory.mkdirs()) throw new IOException("test directory unavailable");
        return directory;
    }

    private static String hash(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder hex = new StringBuilder();
        for (byte element : digest) hex.append(String.format("%02x", element & 0xff));
        return hex.toString();
    }

    private static JSONObject journal(String state) throws Exception {
        byte[] base = "encrypted base".getBytes(StandardCharsets.UTF_8);
        byte[] candidate = "exact encrypted candidate".getBytes(StandardCharsets.UTF_8);
        String encodedBase = android.util.Base64.encodeToString(base, android.util.Base64.NO_WRAP);
        String encodedCandidate = android.util.Base64.encodeToString(candidate,
            android.util.Base64.NO_WRAP);
        return new JSONObject().put("text", "private document content")
            .put("baseRevision", REVISION).put("cursor", new JSONObject()
                .put("start", 0).put("end", 0))
            .put("target", TARGET).put("state", state).put("updateTime", 12345)
            .put("publication", new JSONObject().put("kind", "host-target")
                .put("id", OTHER).put("target", TARGET)
                .put("baseHash", hash(base)).put("candidateHash", hash(candidate))
                .put("base", encodedBase).put("candidate", encodedCandidate)
                .put("stage", "prepared").put("purpose", "regular-save"));
    }

    @Test public void pendingCreateKeepsExactCandidateWithoutInventingABase()
            throws Exception {
        File directory = directory();
        AndroidWorkJournals store = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        byte[] key = new byte[32];
        Arrays.fill(key, (byte)17);
        byte[] candidate = "encrypted candidate".getBytes(StandardCharsets.UTF_8);
        store.writePendingCreate(DOCUMENT, TARGET, key, candidate, "");
        JSONObject envelope = new JSONObject(new String(Files.readAllBytes(
            new File(directory, DOCUMENT + ".work-journal").toPath()),
            StandardCharsets.UTF_8));
        assertArrayEquals(candidate, android.util.Base64.decode(
            envelope.getJSONObject("bootstrap").getString("createCandidate"),
            android.util.Base64.NO_WRAP));
        AndroidWorkJournals.Recovery recovered = store.recover(DOCUMENT, TARGET, key);
        assertEquals(AndroidWorkJournals.Attention.PENDING_PUBLICATION,
            recovered.attention);
        JSONObject publication = recovered.record.getJSONObject("publication");
        assertTrue(publication.getBoolean("creation"));
        assertEquals("", publication.getString("base"));
        assertArrayEquals(candidate, android.util.Base64.decode(
            publication.getString("candidate"), android.util.Base64.NO_WRAP));
        store.clear(DOCUMENT);
        assertEquals(AndroidWorkJournals.Attention.NONE,
            store.recover(DOCUMENT, TARGET, key).attention);
    }

    @Test public void profileAndSettingsUseSharedShapeAndRejectSecrets() throws Exception {
        File directory = directory();
        AndroidProfileSettings store = new AndroidProfileSettings(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject profile = store.saveProfile(new JSONObject()
            .put("name", " Ada ").put("email", "ada@example.org")
            .put("deviceName", "Android").put("password", "hidden secret"));
        assertEquals("Ada", profile.getString("name"));
        assertFalse(new String(Files.readAllBytes(new File(directory, "profile.json").toPath()),
            StandardCharsets.UTF_8)
            .contains("hidden secret"));
        assertEquals("Ada", new AndroidProfileSettings(
            new PrivateStateFiles(directory, () -> {})).loadProfile().getString("name"));
        JSONObject settings = store.saveSettings(new JSONObject()
            .put("regularSaveEnabled", true).put("regularSaveIntervalMs", 10000)
            .put("rawContent", "private document content"));
        assertTrue(settings.getBoolean("regularSaveEnabled"));
        assertFalse(new String(Files.readAllBytes(new File(directory, "settings.json").toPath()),
            StandardCharsets.UTF_8)
            .contains("private document content"));
        try { store.saveSettings(new JSONObject().put("regularSaveIntervalMs", 9999));
            fail("short interval was accepted"); }
        catch (IOException expected) { assertNotNull(expected); }
    }

    @Test public void journalRetainsExactCandidateAcrossNewStoreAndIdentityChecks()
            throws Exception {
        File directory = directory();
        byte[] key = new byte[32];
        Arrays.fill(key, (byte)0x5a);
        AndroidWorkJournals store = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject pending = journal("pending-publication");
        store.write(DOCUMENT, TARGET, key, pending);
        String raw = new String(Files.readAllBytes(
            new File(directory, DOCUMENT + ".work-journal").toPath()), StandardCharsets.UTF_8);
        assertFalse(raw.contains("private document content"));
        assertFalse(raw.contains("exact encrypted candidate"));
        assertFalse(raw.contains(TARGET));
        AndroidWorkJournals restarted = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        AndroidWorkJournals.Recovery recovered = restarted.recover(DOCUMENT, TARGET, key);
        assertEquals(AndroidWorkJournals.Attention.PENDING_PUBLICATION, recovered.attention);
        assertEquals(pending.getJSONObject("publication").getString("candidate"),
            recovered.record.getJSONObject("publication").getString("candidate"));
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            restarted.recover(DOCUMENT, "android-target:different", key).attention);
        assertEquals(AndroidWorkJournals.Attention.NONE,
            restarted.recover(OTHER, TARGET, key).attention);
        byte[] wrong = new byte[32];
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            restarted.recover(DOCUMENT, TARGET, wrong).attention);
        Arrays.fill(key, (byte)0);
    }

    @Test public void failedAndInterruptedReplacementPreserveEarlierJournal()
            throws Exception {
        File directory = directory();
        byte[] key = new byte[32];
        AndroidWorkJournals store = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        store.write(DOCUMENT, TARGET, key, journal("unsaved"));
        AndroidWorkJournals interrupted = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> { throw new IOException("injected failure"); }));
        try { interrupted.write(DOCUMENT, TARGET, key, journal("pending-publication"));
            fail("replacement succeeded"); }
        catch (IOException expected) { assertNotNull(expected); }
        assertEquals(AndroidWorkJournals.Attention.UNSAVED,
            store.recover(DOCUMENT, TARGET, key).attention);
        Files.write(new File(directory, DOCUMENT + ".work-journal").toPath(),
            "broken".getBytes(StandardCharsets.UTF_8));
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            store.recover(DOCUMENT, TARGET, key).attention);
        assertEquals("broken", new String(Files.readAllBytes(
            new File(directory, DOCUMENT + ".work-journal").toPath()),
            StandardCharsets.UTF_8));
    }

    @Test public void presentNonObjectPublicationIsUnreadableNotSilentlyUnsaved()
            throws Exception {
        File directory = directory();
        byte[] key = new byte[32];
        AndroidWorkJournals journals = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject invalid = journal("pending-publication").put("publication", "corrupt");
        try { journals.write(DOCUMENT, TARGET, key, invalid);
            fail("malformed publication was accepted for writing"); }
        catch (IOException expected) { assertNotNull(expected); }
        byte[] nonce = new byte[12];
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"),
            new GCMParameterSpec(128, nonce));
        cipher.updateAAD(("scpefe-work-journal-v1:" + DOCUMENT)
            .getBytes(StandardCharsets.US_ASCII));
        byte[] encrypted = cipher.doFinal(invalid.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("version", 1)
            .put("nonce", android.util.Base64.encodeToString(nonce,
                android.util.Base64.NO_WRAP))
            .put("tag", android.util.Base64.encodeToString(Arrays.copyOfRange(encrypted,
                encrypted.length - 16, encrypted.length), android.util.Base64.NO_WRAP))
            .put("ciphertext", android.util.Base64.encodeToString(Arrays.copyOf(encrypted,
                encrypted.length - 16), android.util.Base64.NO_WRAP));
        File record = new File(directory, DOCUMENT + ".work-journal");
        Files.write(record.toPath(), envelope.toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            journals.recover(DOCUMENT, TARGET, key).attention);
        assertTrue(record.isFile());
    }

    @Test public void witnessPersistsAndFlagsReplacementWithoutOverwriting() throws Exception {
        File directory = directory();
        AndroidHeadWitnesses store = new AndroidHeadWitnesses(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject first = witness(DOCUMENT, REVISION);
        assertEquals(AndroidHeadWitnesses.Comparison.FIRST, store.observe(TARGET, first));
        AndroidHeadWitnesses restarted = new AndroidHeadWitnesses(
            new PrivateStateFiles(directory, () -> {}));
        assertEquals(AndroidHeadWitnesses.Comparison.REPLACEMENT,
            restarted.observe(TARGET, witness(OTHER, REVISION)));
        assertEquals(DOCUMENT, restarted.read(TARGET).getString("documentId"));
        byte[] raw = Files.readAllBytes(new File(directory, "head-witnesses.json").toPath());
        assertFalse(new String(raw, StandardCharsets.UTF_8).contains(TARGET));
        raw[raw.length / 2] ^= 1;
        Files.write(new File(directory, "head-witnesses.json").toPath(), raw);
        assertEquals(AndroidHeadWitnesses.Comparison.UNREADABLE,
            restarted.inspect(TARGET, first));
    }

    @Test public void writeBeforeForcedProcessRestart() throws Exception {
        if (!"write".equals(InstrumentationRegistry.getArguments().getString("restartPhase"))) {
            return;
        }
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        new AndroidProfileSettings(context).saveProfile(new JSONObject()
            .put("name", "Ada").put("email", "ada@example.org")
            .put("deviceName", "Android"));
        new AndroidProfileSettings(context).saveSettings(new JSONObject()
            .put("regularSaveEnabled", true).put("regularSaveIntervalMs", 10000));
        new AndroidWorkJournals(context).write(DOCUMENT, TARGET, new byte[32],
            journal("pending-publication"));
        new AndroidHeadWitnesses(context).accept(TARGET, witness(DOCUMENT, REVISION));
        Files.write(new File(context.getFilesDir(), "state-restart-pid").toPath(),
            Integer.toString(Process.myPid()).getBytes(StandardCharsets.US_ASCII));
    }

    @Test public void recoverAfterForcedProcessRestart() throws Exception {
        if (!"read".equals(InstrumentationRegistry.getArguments().getString("restartPhase"))) {
            return;
        }
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        int previous = Integer.parseInt(new String(Files.readAllBytes(new File(
            context.getFilesDir(), "state-restart-pid").toPath()), StandardCharsets.US_ASCII));
        assertNotEquals(previous, Process.myPid());
        assertEquals("Ada", new AndroidProfileSettings(context).loadProfile().getString("name"));
        assertTrue(new AndroidProfileSettings(context).loadSettings()
            .getBoolean("regularSaveEnabled"));
        AndroidWorkJournals.Recovery journal = new AndroidWorkJournals(context)
            .recover(DOCUMENT, TARGET, new byte[32]);
        assertEquals(AndroidWorkJournals.Attention.PENDING_PUBLICATION, journal.attention);
        assertEquals(journal("pending-publication").getJSONObject("publication")
            .getString("candidate"), journal.record.getJSONObject("publication")
            .getString("candidate"));
        assertEquals(DOCUMENT, new AndroidHeadWitnesses(context)
            .read(TARGET).getString("documentId"));
    }

    private static JSONObject witness(String documentId, String revision) throws Exception {
        return new JSONObject().put("documentId", documentId).put("headRevision", revision)
            .put("graph", new JSONArray().put(new JSONObject().put("revisionId", revision)
                .put("parentRevisionIds", new JSONArray())));
    }
}
